use scorebook_core::{
    chat::*,
    error::{Error, RetryDirective},
    ports::AppFuture,
};
pub struct UnconfiguredChatModel;
impl ChatModelProvider for UnconfiguredChatModel {
    fn model_id(&self) -> &str {
        "unconfigured"
    }
    fn reply(&self, _: ModelRequest) -> AppFuture<'_, ModelReply> {
        Box::pin(async {
            Err(Error::deferred(
                "chat_model_not_configured",
                RetryDirective::AwaitCapability,
            ))
        })
    }
}
