use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use super::sqlite::QueryCancellation;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RequestExecutionClass {
    #[default]
    Interactive,
    Background,
    Maintenance,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum RequestExecutionPhase {
    Admission = 0,
    #[default]
    ModuleCpu = 1,
    ReaderCheckout = 2,
    ReaderQuery = 3,
    WriterQueue = 4,
    WriterExecution = 5,
    Response = 6,
}

impl RequestExecutionPhase {
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Admission,
            2 => Self::ReaderCheckout,
            3 => Self::ReaderQuery,
            4 => Self::WriterQueue,
            5 => Self::WriterExecution,
            6 => Self::Response,
            _ => Self::ModuleCpu,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admission => "admission",
            Self::ModuleCpu => "module_cpu",
            Self::ReaderCheckout => "reader_checkout",
            Self::ReaderQuery => "reader_query",
            Self::WriterQueue => "writer_queue",
            Self::WriterExecution => "writer_execution",
            Self::Response => "response",
        }
    }
}

#[derive(Clone)]
pub struct RequestExecutionObserver {
    phase: Arc<AtomicU8>,
}

impl RequestExecutionObserver {
    pub fn phase(&self) -> RequestExecutionPhase {
        RequestExecutionPhase::from_u8(self.phase.load(Ordering::Acquire))
    }

    pub fn set_phase(&self, phase: RequestExecutionPhase) {
        self.phase.store(phase as u8, Ordering::Release);
    }
}

#[derive(Clone)]
pub struct RequestExecutionContext {
    class: RequestExecutionClass,
    cancellation: QueryCancellation,
    deadline: Instant,
    observer: RequestExecutionObserver,
}

impl RequestExecutionContext {
    pub fn new(
        class: RequestExecutionClass,
        cancellation: QueryCancellation,
        deadline: Instant,
    ) -> Self {
        Self {
            class,
            cancellation,
            deadline,
            observer: RequestExecutionObserver {
                phase: Arc::new(AtomicU8::new(RequestExecutionPhase::ModuleCpu as u8)),
            },
        }
    }

    pub fn cancellation(&self) -> QueryCancellation {
        self.cancellation.clone()
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn observer(&self) -> RequestExecutionObserver {
        self.observer.clone()
    }
}

pub fn current_request_execution_class() -> RequestExecutionClass {
    CURRENT.with(|current| {
        current
            .borrow()
            .last()
            .map_or(RequestExecutionClass::Interactive, |context| context.class)
    })
}

pub(crate) fn current_request_execution_observer() -> Option<RequestExecutionObserver> {
    CURRENT.with(|current| {
        current
            .borrow()
            .last()
            .map(|context| context.observer.clone())
    })
}

pub(crate) fn enter_request_execution_phase(
    phase: RequestExecutionPhase,
) -> Option<RequestExecutionPhaseGuard> {
    let observer = current_request_execution_observer()?;
    let previous = observer.phase();
    observer.set_phase(phase);
    Some(RequestExecutionPhaseGuard { observer, previous })
}

pub(crate) struct RequestExecutionPhaseGuard {
    observer: RequestExecutionObserver,
    previous: RequestExecutionPhase,
}

impl Drop for RequestExecutionPhaseGuard {
    fn drop(&mut self) {
        self.observer.set_phase(self.previous);
    }
}

thread_local! {
    static CURRENT: RefCell<Vec<RequestExecutionContext>> = const { RefCell::new(Vec::new()) };
}

/// Runs synchronous Core work inside the transport-owned execution context.
/// Store readers and the writer inherit its absolute deadline and cancellation
/// without exposing transport policy through semantic Module interfaces.
pub fn within_request_execution<T>(
    context: RequestExecutionContext,
    operation: impl FnOnce() -> T,
) -> T {
    CURRENT.with(|current| current.borrow_mut().push(context));
    let _guard = RequestExecutionGuard;
    operation()
}

/// Reports whether the transport has cancelled the synchronous request that
/// owns the current worker thread.
pub fn request_is_cancelled() -> bool {
    CURRENT.with(|current| {
        current
            .borrow()
            .last()
            .is_some_and(|context| context.cancellation.is_cancelled())
    })
}

/// Stops synchronous CPU work at the same cancellation/deadline boundary as
/// SQLite work. Callers use this at bounded collection and transformation
/// checkpoints so a cancelled request does not retain an execution permit
/// until an entire reconstruction or transfer finishes.
pub fn check_request_interruption() -> Result<(), super::sqlite::StoreError> {
    CURRENT.with(|current| {
        let current = current.borrow();
        let Some(context) = current.last() else {
            return Ok(());
        };
        if context.cancellation.is_cancelled() {
            return Err(super::sqlite::query_interrupted(true));
        }
        if Instant::now() >= context.deadline {
            return Err(super::sqlite::query_interrupted(false));
        }
        Ok(())
    })
}

pub(crate) fn query_control(
    fallback_budget: Duration,
    cancellation: QueryCancellation,
) -> (Instant, QueryCancellation) {
    CURRENT.with(|current| {
        let current = current.borrow();
        let Some(context) = current.last() else {
            return (Instant::now() + fallback_budget, cancellation);
        };
        (
            // A transported Module request has exactly one semantic deadline.
            // The fallback protects direct Store use, but must not become a
            // hidden, shorter timeout inside the request-execution seam.
            context.deadline,
            cancellation.combined(&context.cancellation),
        )
    })
}

/// Behavioral/pressure tests may budget debug-build work independently of production latency.
/// Deadline and cancellation tests must use their own explicit execution context instead.
#[cfg(test)]
pub(crate) fn with_test_request_budget<T>(operation: impl FnOnce() -> T) -> T {
    within_request_execution(
        RequestExecutionContext::new(
            RequestExecutionClass::Interactive,
            QueryCancellation::new(),
            Instant::now() + Duration::from_secs(60),
        ),
        operation,
    )
}

struct RequestExecutionGuard;

impl Drop for RequestExecutionGuard {
    fn drop(&mut self) {
        CURRENT.with(|current| {
            current.borrow_mut().pop();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_deadline_and_cancellation_without_leaking_to_later_work() {
        let request_cancellation = QueryCancellation::new();
        let explicit_cancellation = QueryCancellation::new();
        let request_deadline = Instant::now() + Duration::from_secs(2);

        within_request_execution(
            RequestExecutionContext::new(
                RequestExecutionClass::Background,
                request_cancellation.clone(),
                request_deadline,
            ),
            || {
                assert_eq!(
                    current_request_execution_class(),
                    RequestExecutionClass::Background
                );
                let (deadline, combined) =
                    query_control(Duration::from_secs(10), explicit_cancellation.clone());
                assert_eq!(deadline, request_deadline);
                request_cancellation.cancel();
                assert!(combined.is_cancelled());
            },
        );

        let (_, independent) = query_control(Duration::from_secs(10), explicit_cancellation);
        assert!(!independent.is_cancelled());
        assert_eq!(
            current_request_execution_class(),
            RequestExecutionClass::Interactive
        );
    }

    #[test]
    fn transported_request_deadline_replaces_the_direct_store_fallback() {
        let request_deadline = Instant::now() + Duration::from_secs(20);
        within_request_execution(
            RequestExecutionContext::new(
                RequestExecutionClass::Interactive,
                QueryCancellation::new(),
                request_deadline,
            ),
            || {
                let (deadline, _) =
                    query_control(Duration::from_secs(10), QueryCancellation::new());
                assert_eq!(deadline, request_deadline);
            },
        );
    }

    #[test]
    fn interruption_checkpoint_reports_request_cancellation_and_deadline() {
        let cancellation = QueryCancellation::new();
        within_request_execution(
            RequestExecutionContext::new(
                RequestExecutionClass::Interactive,
                cancellation.clone(),
                Instant::now() + Duration::from_secs(2),
            ),
            || {
                cancellation.cancel();
                assert_eq!(
                    check_request_interruption()
                        .expect_err("cancelled request passed an interruption checkpoint")
                        .code,
                    crate::infrastructure::sqlite::StoreErrorCode::QueryCancelled,
                );
            },
        );

        within_request_execution(
            RequestExecutionContext::new(
                RequestExecutionClass::Interactive,
                QueryCancellation::new(),
                Instant::now(),
            ),
            || {
                assert_eq!(
                    check_request_interruption()
                        .expect_err("expired request passed an interruption checkpoint")
                        .code,
                    crate::infrastructure::sqlite::StoreErrorCode::DeadlineExceeded,
                );
            },
        );
    }
}
