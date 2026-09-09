use super::*;
use scorebook_core::api::statistics::*;
pub fn routes() -> Router<Services> {
    Router::new()
        .route("/v1/statistics/runs", post(create))
        .route("/v1/statistics/runs/{id}", get(run))
        .route("/v1/statistics/runs/{id}/members", get(members))
        .route("/v1/baseline-runs", post(baseline))
        .route("/v1/baseline-runs/{id}", get(baseline_get))
        .route("/v1/baseline-runs/{id}/samples", get(samples))
        .route("/v1/verdict-requests", get(requests))
        .route("/v1/verdicts", post(decide))
}
macro_rules! write {
    ($name:ident,$input:ty,$action:ident) => {
        async fn $name(
            State(s): State<Services>,
            Extension(o): Extension<Uuid>,
            h: HeaderMap,
            Json(v): Json<$input>,
        ) -> Result<Json<Value>> {
            invoke(&s, o, Action::$action, None, Some(key(&h)?), json!(v)).await
        }
    };
}
write!(create, StatisticsInput, StatisticsCreate);
write!(baseline, BaselineInput, BaselineCreate);
write!(decide, VerdictInput, VerdictDecide);
async fn run(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::StatisticsGet, Some(id), None, json!({})).await
}
async fn baseline_get(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::BaselineGet, Some(id), None, json!({})).await
}
async fn members(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    Query(v): Query<MemberFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::StatisticsMembers, Some(id), None, json!(v)).await
}
async fn samples(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Path(id): Path<Uuid>,
    Query(v): Query<MemberFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::BaselineSamples, Some(id), None, json!(v)).await
}
async fn requests(
    State(s): State<Services>,
    Extension(o): Extension<Uuid>,
    Query(v): Query<VerdictFilter>,
) -> Result<Json<Value>> {
    invoke(&s, o, Action::VerdictRequests, None, None, json!(v)).await
}
