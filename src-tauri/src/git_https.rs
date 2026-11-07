use crate::{
    git::{GitAuth, GitError, Tip},
    vault::{GitEnvelope, MAX_GIT_DOCUMENT},
};
use git2::{
    AutotagOption, Cred, CredentialType, Direction, Error, ErrorCode, FetchOptions, Oid,
    PushOptions, Remote, RemoteCallbacks, RemoteRedirect, Repository, RepositoryInitOptions,
    Signature,
};
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;

pub struct HttpsRepo {
    dir: Arc<tempfile::TempDir>,
    url: String,
    auth: GitAuth,
    cancel: CancellationToken,
}

impl HttpsRepo {
    pub async fn open(
        url: String,
        auth: GitAuth,
        cancel: CancellationToken,
    ) -> Result<Self, String> {
        static INIT: OnceLock<Result<(), GitError>> = OnceLock::new();
        INIT.get_or_init(|| {
            // libgit2 timeouts are process-wide. Set them once before starting its workers.
            unsafe {
                git2::opts::set_server_connect_timeout_in_milliseconds(12_000)?;
                git2::opts::set_server_timeout_in_milliseconds(45_000)?;
                #[cfg(target_os = "android")]
                for dir in [
                    "/apex/com.android.conscrypt/cacerts",
                    "/system/etc/security/cacerts",
                ] {
                    if std::path::Path::new(dir).is_dir() {
                        git2::opts::set_ssl_cert_dir(dir)?;
                        break;
                    }
                }
            }
            Ok(())
        })
        .clone()?;
        let repo = Self {
            dir: Arc::new(tempfile::tempdir().map_err(crate::error)?),
            url,
            auth,
            cancel,
        };
        repo.work(|path, _, _, _| {
            let mut options = RepositoryInitOptions::new();
            options.bare(true).external_template(false);
            let db = Repository::init_opts(path, &options)?;
            let mut config = db.config()?;
            config.set_bool("http.followRedirects", false)?;
            config.set_bool("http.sslVerify", true)?;
            Ok(())
        })
        .await?;
        Ok(repo)
    }

    async fn work<T, F>(&self, task: F) -> Result<T, GitError>
    where
        T: Send + 'static,
        F: FnOnce(&std::path::Path, &str, &GitAuth, &CancellationToken) -> Result<T, GitError>
            + Send
            + 'static,
    {
        if self.cancel.is_cancelled() {
            return Err(GitError::message("同步已取消。"));
        }
        let (dir, url, auth, cancel) = (
            self.dir.clone(),
            self.url.clone(),
            self.auth.clone(),
            self.cancel.clone(),
        );
        let job = tokio::task::spawn_blocking(move || task(dir.path(), &url, &auth, &cancel));
        tokio::select! {
            _ = self.cancel.cancelled() => Err(GitError::message("同步已取消。")),
            result = job => result.map_err(|_| GitError::message("HTTPS Git 操作中断。"))?,
        }
    }

    pub async fn refs(&self) -> Result<String, GitError> {
        self.work(|path, url, auth, cancel| {
            let db = Repository::open_bare(path)?;
            let mut remote = checked_remote(&db, url)?;
            let connection =
                remote.connect_auth(Direction::Fetch, Some(callbacks(url, auth, cancel)), None)?;
            let mut refs = String::new();
            for head in connection.list()? {
                let name = head.name();
                if name.starts_with("refs/") && !name.ends_with("^{}") {
                    use std::fmt::Write;
                    let _ = writeln!(refs, "{}\t{name}", head.oid());
                    if refs.len() as u64 > MAX_GIT_DOCUMENT {
                        return Err(GitError::message("Git 引用列表超过大小上限。"));
                    }
                }
            }
            Ok(refs)
        })
        .await
    }

    pub async fn fetch(&self, reference: &str) -> Result<Tip, GitError> {
        let refspec = format!("+{reference}:refs/termlume/tip");
        self.work(move |path, url, auth, cancel| {
            let db = Repository::open_bare(path)?;
            let mut options = FetchOptions::new();
            options
                .download_tags(AutotagOption::None)
                .follow_redirects(RemoteRedirect::None)
                .remote_callbacks(callbacks(url, auth, cancel));
            checked_remote(&db, url)?.fetch(&[&refspec], Some(&mut options), None)?;
            let commit = db.find_reference("refs/termlume/tip")?.peel_to_commit()?;
            let parent = match commit.parent_count() {
                0 => None,
                1 => Some(commit.parent_id(0)?.to_string()),
                _ => return Err(GitError::message("同步分支提交历史无效。")),
            };
            let tree = commit.tree()?;
            let blob = tree
                .get_name("vault.json")
                .ok_or_else(|| GitError::message("仓库中没有 vault.json。"))?;
            let (size, size_kind) = db.odb()?.read_header(blob.id())?;
            if size_kind != git2::ObjectType::Blob {
                return Err(GitError::message("仓库中的保险库格式无效。"));
            }
            if size == 0 || size as u64 > MAX_GIT_DOCUMENT {
                return Err(GitError::message("仓库中的保险库大小无效。"));
            }
            let blob = db.find_blob(blob.id())?;
            Ok(Tip {
                commit: commit.id().to_string(),
                parent,
                envelope: serde_json::from_slice(blob.content())
                    .map_err(|e| GitError::message(crate::error(e)))?,
            })
        })
        .await
    }

    pub async fn descendant(&self, base: String, tip: String) -> Result<bool, GitError> {
        self.work(move |path, _, _, _| {
            let db = Repository::open_bare(path)?;
            let (base, tip) = (Oid::from_str(&base)?, Oid::from_str(&tip)?);
            if base == tip {
                return Ok(true);
            }
            match db.graph_descendant_of(tip, base) {
                Ok(result) => Ok(result),
                Err(e) if e.code() == ErrorCode::NotFound => Ok(false),
                Err(e) => Err(e.into()),
            }
        })
        .await
    }

    pub async fn create_commit(
        &self,
        envelope: &GitEnvelope,
        parent: Option<&str>,
    ) -> Result<String, GitError> {
        let bytes = serde_json::to_vec(envelope).map_err(|e| GitError::message(crate::error(e)))?;
        let parent = parent.map(str::to_owned);
        self.work(move |path, _, _, _| {
            let db = Repository::open_bare(path)?;
            let blob = db.blob(&bytes)?;
            let mut tree = db.treebuilder(None)?;
            tree.insert("vault.json", blob, 0o100644)?;
            let tree = db.find_tree(tree.write()?)?;
            let parent = parent
                .map(|id| db.find_commit(Oid::from_str(&id)?))
                .transpose()?;
            let parents: Vec<_> = parent.iter().collect();
            let author = Signature::now("Termlume", "vault@termlume.invalid")?;
            Ok(db
                .commit(
                    None,
                    &author,
                    &author,
                    "Update encrypted Termlume vault",
                    &tree,
                    &parents,
                )?
                .to_string())
        })
        .await
    }

    pub async fn push(
        &self,
        commit: &str,
        reference: &str,
        create_only: bool,
    ) -> Result<(), GitError> {
        let commit = Oid::from_str(commit)?;
        let reference = reference.to_owned();
        self.work(move |path, url, auth, cancel| {
            let db = Repository::open_bare(path)?;
            let staging = "refs/termlume/push";
            db.reference(staging, commit, true, "Stage encrypted snapshot")?;
            let mut callbacks = callbacks(url, auth, cancel);
            callbacks.push_negotiation(|updates| {
                if cancel.is_cancelled() {
                    return Err(Error::from_str("cancelled"));
                }
                if create_only && updates.iter().any(|update| !update.src().is_zero()) {
                    return Err(Error::new(
                        ErrorCode::Modified,
                        git2::ErrorClass::Reference,
                        "remote branch exists",
                    ));
                }
                Ok(())
            });
            callbacks.push_update_reference(|_, status| {
                if status.is_some() {
                    return Err(Error::from_str("remote rejected update"));
                }
                Ok(())
            });
            let mut options = PushOptions::new();
            options
                .follow_redirects(RemoteRedirect::None)
                .remote_callbacks(callbacks);
            checked_remote(&db, url)?
                .push(&[format!("{staging}:{reference}")], Some(&mut options))?;
            Ok(())
        })
        .await
    }
}

fn checked_remote<'a>(db: &'a Repository, url: &str) -> Result<Remote<'a>, GitError> {
    let remote = db.remote_anonymous(url)?;
    if remote.url()? != url || remote.pushurl()?.is_some_and(|push_url| push_url != url) {
        return Err(GitError::message("Git 仓库地址被本机配置重写。"));
    }
    Ok(remote)
}

fn callbacks<'a>(
    url: &'a str,
    auth: &'a GitAuth,
    cancel: &'a CancellationToken,
) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    #[cfg(test)]
    if let Some(fixture) = std::env::var_os("TERMLUME_TEST_FIXTURE") {
        if url::Url::parse(url)
            .ok()
            .is_some_and(|url| url.host_str() == Some("127.0.0.1"))
        {
            if let Ok(expected) = std::fs::read(std::path::Path::new(&fixture).join("https.der")) {
                callbacks.certificate_check(move |cert, _| {
                    Ok(
                        if cert.as_x509().is_some_and(|cert| cert.data() == expected) {
                            git2::CertificateCheckStatus::CertificateOk
                        } else {
                            git2::CertificateCheckStatus::CertificatePassthrough
                        },
                    )
                });
            }
        }
    }
    let mut supplied = false;
    callbacks.credentials(move |destination, _, allowed| {
        if supplied
            || cancel.is_cancelled()
            || destination != url
            || !allowed.contains(CredentialType::USER_PASS_PLAINTEXT)
        {
            return Err(Error::new(
                ErrorCode::Auth,
                git2::ErrorClass::Http,
                "authentication failed",
            ));
        }
        supplied = true;
        Cred::userpass_plaintext(&auth.username, &auth.token)
    });
    callbacks.transfer_progress(|_| !cancel.is_cancelled());
    callbacks.sideband_progress(|_| !cancel.is_cancelled());
    callbacks
}

impl From<Error> for GitError {
    fn from(error: Error) -> Self {
        let code = error.code();
        let detail = if code == ErrorCode::Auth {
            "HTTPS 仓库认证失败，请核对用户名、Token 和仓库权限。"
        } else if code == ErrorCode::Certificate {
            "HTTPS 仓库证书校验失败。"
        } else {
            "HTTPS Git 操作失败，请检查仓库地址、网络和写入权限。"
        };
        let mut error = GitError::message(detail);
        error.concurrent = matches!(
            code,
            ErrorCode::NotFastForward | ErrorCode::Modified | ErrorCode::Locked
        );
        error
    }
}
