use crate::assets::Preferences;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ID: Uuid = Uuid::from_u128(0x25c763e5_dd73_5c47_aa17_505245465331);

// Explicit allowlist: device credentials, security policy, histories and logs stay local.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedPreferences {
    pub id: Uuid,
    pub version: u8,
    pub theme: String,
    pub terminal_theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub host_sort: String,
    pub group_sort: String,
    pub host_layout: Option<String>,
    pub navigation_collapsed: Option<bool>,
}

impl SharedPreferences {
    pub fn from_local(p: &Preferences) -> Self {
        Self {
            id: ID,
            version: 1,
            theme: p.theme.clone(),
            terminal_theme: p.terminal_theme.clone(),
            font_family: p.font_family.clone(),
            font_size: p.font_size,
            host_sort: p.host_sort.clone(),
            group_sort: p.group_sort.clone(),
            host_layout: p.host_layout.clone(),
            navigation_collapsed: p.navigation_collapsed,
        }
    }

    pub fn apply(&self, p: &mut Preferences) {
        p.theme.clone_from(&self.theme);
        p.terminal_theme.clone_from(&self.terminal_theme);
        p.font_family.clone_from(&self.font_family);
        p.font_size = self.font_size;
        p.host_sort.clone_from(&self.host_sort);
        p.group_sort.clone_from(&self.group_sort);
        p.host_layout.clone_from(&self.host_layout);
        p.navigation_collapsed = self.navigation_collapsed;
    }

    pub fn normalized(self) -> Result<Self, String> {
        if self.id != ID || self.version != 1 {
            return Err("不支持此共享偏好版本，请更新 Termlume。".into());
        }
        let mut p = Preferences::default();
        self.apply(&mut p);
        crate::assets::validate_preferences(&p)?;
        Ok(self)
    }
}
