use super::criteria::{Criteria, Template};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Preview {
    pub original_text: String,
    pub path: String,
    pub stance: String,
    pub criteria: Criteria,
    pub issues: Vec<String>,
}
/// Only slash protocol before ` | ` is syntax. Plain Chinese text is never sentiment-parsed.
pub fn preview(text: &str) -> Preview {
    let mut p = Preview {
        original_text: text.into(),
        path: "unknown".into(),
        stance: "unknown".into(),
        criteria: Criteria::default(),
        issues: vec![],
    };
    let Some((prefix, _)) = text.split_once(" | ") else {
        return p;
    };
    let mut seen = std::collections::HashSet::new();
    for token in prefix.split_whitespace() {
        let (key, value) = if let Some(v) = token.strip_prefix("s=") {
            ("s", v)
        } else if let Some(v) = token.strip_prefix("h=") {
            ("h", v)
        } else if let Some(v) = token.strip_prefix("theta=") {
            ("theta", v)
        } else if matches!(token, "/k" | "/t" | "/kt") {
            ("path", token)
        } else if matches!(token, "L" | "S" | "?" | "C") {
            ("stance", token)
        } else {
            continue;
        };
        if !seen.insert(key) {
            p.issues.push(format!("duplicate_{key}"));
            continue;
        }
        match key {
            "path" => {
                p.path = match value {
                    "/k" => "chart_first",
                    "/t" => "thought_first",
                    _ => "interwoven",
                }
                .into()
            }
            "stance" => p.stance = value.into(),
            "s" => p.criteria.invalidation = Some(value.into()),
            "h" => {
                p.criteria.horizon_hours = value.parse().ok();
                if p.criteria.horizon_hours.is_none() {
                    p.issues.push("invalid_horizon".into())
                }
            }
            "theta" => p.criteria.threshold_ratio = Some(value.into()),
            _ => {}
        }
    }
    if matches!(p.stance.as_str(), "L" | "S") {
        p.criteria.template = if p.criteria.invalidation.is_some() {
            Template::T2
        } else {
            Template::T1
        };
        p.criteria.direction = Some(p.stance.clone());
        p.criteria.horizon_hours = p.criteria.horizon_hours.or(Some(72));
        p.criteria.selected_by = Some("default_visible".into());
    }
    if let Err(e) = super::criteria::validate(&p.criteria) {
        p.issues.push(e)
    }
    if !p.issues.is_empty() {
        p.criteria = Criteria::default()
    }
    p
}
