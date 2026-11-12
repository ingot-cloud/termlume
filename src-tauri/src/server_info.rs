use crate::{error, ssh::Session};
use russh::ChannelMsg;
use std::time::Duration;

const LIMIT: usize = 256 * 1024;

fn snapshot(output: Vec<u8>, exit: Option<u32>) -> Result<String, String> {
    if exit != Some(0) {
        return Err("服务器信息采集失败，请确认远端允许执行 sh 命令。".into());
    }
    let text = String::from_utf8(output).map_err(|_| "服务器返回的信息编码无效。")?;
    if !text.contains("__TERMLUME_INFO__version\n1\n")
        || !text.trim_end().ends_with("__TERMLUME_INFO__end\nok")
    {
        return Err("服务器返回的信息不完整，请刷新重试。".into());
    }
    Ok(text)
}

pub async fn collect(session: &Session) -> Result<String, String> {
    let client = session.client.get().ok_or("SSH 会话已断开。")?;
    let mut channel = tokio::select! {
        _ = session.cancel.cancelled() => return Err("SSH 会话已断开。".into()),
        result = tokio::time::timeout(Duration::from_secs(5), client.channel_open_session()) =>
            result.map_err(|_| "打开服务器信息通道超时。")?.map_err(error)?,
    };
    let read = async {
        let script = include_str!("../../src/server-info.sh").replace('\'', "'\\''");
        channel.exec(true, format!("sh -c '{script}'").into_bytes()).await.map_err(error)?;
        let mut output = Vec::new();
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > LIMIT {
                        return Err("服务器信息超过大小限制。".into());
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::Failure => return Err("服务器拒绝采集信息。".into()),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        snapshot(output, exit)
    };
    let result = tokio::select! {
        _ = session.cancel.cancelled() => Err("SSH 会话已断开。".into()),
        result = tokio::time::timeout(Duration::from_secs(12), read) =>
            result.map_err(|_| "采集服务器信息超时，请刷新重试。".to_string()).and_then(|r| r),
    };
    let _ = tokio::time::timeout(Duration::from_millis(500), channel.close()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_failed_truncated_and_invalid_snapshots() {
        let valid = b"\n__TERMLUME_INFO__version\n1\n__TERMLUME_INFO__end\nok\n";
        assert!(snapshot(valid.to_vec(), Some(0)).is_ok());
        assert!(snapshot(valid.to_vec(), Some(1)).is_err());
        assert!(snapshot(valid.to_vec(), None).is_err());
        assert!(snapshot(valid[..30].to_vec(), Some(0)).is_err());
        assert!(snapshot(vec![255], Some(0)).is_err());
    }
}
