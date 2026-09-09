//! Sample identity is selected before outcomes; exploratory replays are never official evidence.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
pub struct Sample {
    pub call_id: Uuid,
    pub claim_no: usize,
    pub submitted_at: DateTime<Utc>,
    pub episode_id: Option<Uuid>,
    pub group_pending: bool,
    pub signature: String,
    pub state: String,
    pub eligible: bool,
    pub voided: bool,
}
pub fn summarize(samples: &[Sample], last_verdict_count: usize) -> Value {
    let mut sorted = samples.to_vec();
    sorted.sort_by_key(|s| (s.submitted_at, s.call_id, s.claim_no));
    let mut representatives = BTreeMap::<(String, String), Sample>::new();
    let mut states: BTreeMap<String, Vec<Value>> = [
        "realized",
        "unrealized",
        "not_triggered",
        "pending",
        "no_criteria",
        "insufficient_data",
    ]
    .into_iter()
    .map(|x| (x.into(), vec![]))
    .collect();
    for s in &sorted {
        states
            .entry(s.state.clone())
            .or_default()
            .push(json!({"call_id":s.call_id,"claim_no":s.claim_no}));
        if s.eligible && !s.group_pending {
            representatives
                .entry((
                    s.episode_id.unwrap_or(s.call_id).to_string(),
                    s.signature.clone(),
                ))
                .or_insert_with(|| s.clone());
        }
    }
    let mut groups = HashMap::<String, Vec<Sample>>::new();
    for s in representatives.into_values() {
        groups.entry(s.signature.clone()).or_default().push(s);
    }
    let mut output = BTreeMap::new();
    for (signature, mut reps) in groups {
        reps.sort_by_key(|s| (s.submitted_at, s.call_id));
        let explicit: Vec<_> = reps
            .iter()
            .filter(|s| matches!(s.state.as_str(), "realized" | "unrealized"))
            .collect();
        let wins: Vec<_> = explicit
            .iter()
            .filter(|s| s.state == "realized")
            .map(|s| json!({"call_id":s.call_id,"claim_no":s.claim_no}))
            .collect();
        let n = explicit.len();
        let rate = if n == 0 {
            None
        } else {
            Some(wins.len() as f64 / n as f64)
        };
        let recent: Vec<_> = explicit.iter().rev().take(10).collect();
        let recheck = recent.len() == 10
            && rate.is_some_and(|all| {
                all - recent.iter().filter(|s| s.state == "realized").count() as f64 / 10.0
                    >= 0.2 - 1e-12
            });
        output.insert(signature,json!({"representative_ids":reps.iter().map(|s|json!({"call_id":s.call_id,"claim_no":s.claim_no})).collect::<Vec<_>>(),"numerator_ids":wins,"denominator_ids":explicit.iter().map(|s|json!({"call_id":s.call_id,"claim_no":s.claim_no})).collect::<Vec<_>>(),"numerator":wins.len(),"denominator":n,"realization_rate":rate,"verdict_status":if n<20{"insufficient"}else if n>=last_verdict_count+20{"verdict_due"}else{"observing"},"recheck":recheck,"wilson_interval":null,"wilson_reason":"independence_not_established"}));
    }
    json!({"claim_count":samples.len(),"state_members":states,"compatible_groups":output,"pending_group_claims":samples.iter().filter(|s|s.group_pending).count(),"voided_claims_retained":samples.iter().filter(|s|s.voided).count(),"merged_win_rate":null,"result_policy":"latest_original_or_data_revision;exclude_rule_replay"})
}
