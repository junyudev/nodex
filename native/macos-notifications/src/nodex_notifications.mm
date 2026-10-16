#include <node_api.h>
#include <memory>
#include <mutex>
#include <string>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

namespace {
struct AuthorizationResult {
  std::string status;
  std::string error;
};

struct AuthorizationCall {
  std::mutex mutex;
  napi_threadsafe_function function = nullptr;
  napi_deferred deferred = nullptr;
  bool cleanup_registered = false;
};
using SharedCall = std::shared_ptr<AuthorizationCall>;

std::string AuthorizationStatus(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined: return "not-determined";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusAuthorized: return "authorized";
    case UNAuthorizationStatusProvisional: return "provisional";
    default: return "unknown";
  }
}

void CleanupAuthorization(void *data) {
  const auto &call = *static_cast<SharedCall *>(data);
  std::lock_guard<std::mutex> lock(call->mutex);
  call->cleanup_registered = false;
  if (call->function == nullptr) return;
  napi_release_threadsafe_function(call->function, napi_tsfn_abort);
  call->function = nullptr;
}

void FinalizeAuthorization(napi_env env, void *data, void *) {
  auto *owner = static_cast<SharedCall *>(data);
  if ((*owner)->cleanup_registered) napi_remove_env_cleanup_hook(env, CleanupAuthorization, owner);
  delete owner;
}

void ResolveAuthorization(napi_env env, napi_value, void *context, void *data) {
  std::unique_ptr<AuthorizationResult> result(static_cast<AuthorizationResult *>(data));
  if (env == nullptr) return;
  auto *call = static_cast<AuthorizationCall *>(context);
  const bool failed = !result->error.empty();
  const std::string &text = failed ? result->error : result->status;
  napi_value value;
  if (napi_create_string_utf8(env, text.data(), text.size(), &value) != napi_ok) return;
  if (!failed) {
    napi_resolve_deferred(env, call->deferred, value);
    return;
  }
  napi_value error;
  if (napi_create_error(env, nullptr, value, &error) == napi_ok) napi_reject_deferred(env, call->deferred, error);
}

void CompleteAuthorization(const SharedCall &call, AuthorizationResult result) {
  std::lock_guard<std::mutex> lock(call->mutex);
  // Environment teardown invalidates the callback before releasing its N-API handle.
  if (call->function == nullptr) return;
  auto *data = new AuthorizationResult(std::move(result));
  if (napi_call_threadsafe_function(call->function, data, napi_tsfn_nonblocking) != napi_ok) delete data;
  napi_release_threadsafe_function(call->function, napi_tsfn_release);
  call->function = nullptr;
}

napi_value StartAuthorization(napi_env env, bool request) {
  auto call = std::make_shared<AuthorizationCall>();
  napi_value promise, name;
  if (napi_create_promise(env, &call->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "nodex-notification-authorization", NAPI_AUTO_LENGTH, &name) != napi_ok) {
    napi_throw_error(env, nullptr, "Unable to initialize native notification authorization");
    return nullptr;
  }
  auto *owner = new SharedCall(call);
  if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, owner,
      FinalizeAuthorization, call.get(), ResolveAuthorization, &call->function) != napi_ok) {
    delete owner;
    napi_throw_error(env, nullptr, "Unable to initialize native notification authorization callback");
    return nullptr;
  }
  if (napi_add_env_cleanup_hook(env, CleanupAuthorization, owner) != napi_ok) {
    napi_release_threadsafe_function(call->function, napi_tsfn_abort);
    napi_throw_error(env, nullptr, "Unable to own native notification authorization callback");
    return nullptr;
  }
  call->cleanup_registered = true;
  // OS authorization dialogs cannot be cancelled, but must not keep Electron alive.
  if (napi_unref_threadsafe_function(env, call->function) != napi_ok) {
    CompleteAuthorization(call, {"", "Unable to release native authorization event-loop ownership"});
    return promise;
  }
  @try {
    // A separate helper would query its own bundle rather than Electron's authorization.
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    void (^readSettings)(void) = ^{
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        CompleteAuthorization(call, {AuthorizationStatus(settings.authorizationStatus), ""});
      }];
    };
    if (request) {
      [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                            completionHandler:^(BOOL, NSError *error) {
        if (error != nil) {
          CompleteAuthorization(call, {"", error.localizedDescription.UTF8String ?: "Notification authorization failed"});
          return;
        }
        readSettings();
      }];
    } else {
      readSettings();
    }
  } @catch (NSException *exception) {
    CompleteAuthorization(call, {"", exception.reason.UTF8String ?: "Native notification authorization is unavailable"});
  }
  return promise;
}

napi_value ReadAuthorization(napi_env env, napi_callback_info) { return StartAuthorization(env, false); }
napi_value RequestAuthorization(napi_env env, napi_callback_info) { return StartAuthorization(env, true); }

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"readAuthorization", nullptr, ReadAuthorization, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requestAuthorization", nullptr, RequestAuthorization, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "Unable to initialize native notification authorization");
    return nullptr;
  }
  return exports;
}
} // namespace

NAPI_MODULE(nodex_notifications, Init)
