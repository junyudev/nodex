#include <node_api.h>
#include <dispatch/dispatch.h>
#include <mach/mach_time.h>
#include <string>
#import <DeviceCheck/DeviceCheck.h>
#import <Foundation/Foundation.h>

namespace {
constexpr int64_t kTimeoutNanoseconds = 30LL * NSEC_PER_SEC;

#define NAPI_CHECK(call) \
  if ((call) != napi_ok) { \
    napi_throw_error(env, nullptr, "DeviceCheck bridge argument or allocation failed"); \
    return nullptr; \
  }

struct TokenWork {
  napi_async_work work;
  napi_deferred deferred;
  bool supported = false;
  double latencyMs = 0;
  std::string tokenBase64;
  std::string error;
};

double ElapsedMilliseconds(uint64_t started, uint64_t finished) {
  mach_timebase_info_data_t timebase;
  mach_timebase_info(&timebase);
  const double nanos = static_cast<double>(finished - started) *
                       static_cast<double>(timebase.numer) / static_cast<double>(timebase.denom);
  return nanos / 1'000'000.0;
}

void ExecuteToken(napi_env, void *data) {
  auto *state = static_cast<TokenWork *>(data);
  @autoreleasepool {
    @try {
      DCDevice *device = DCDevice.currentDevice;
      state->supported = device.isSupported;
      if (!state->supported) return;

      const uint64_t started = mach_continuous_time();
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      __block NSData *token = nil;
      __block NSError *failure = nil;
      [device generateTokenWithCompletionHandler:^(NSData *value, NSError *error) {
        token = value;
        failure = error;
        dispatch_semaphore_signal(semaphore);
      }];
      const long waitResult = dispatch_semaphore_wait(
          semaphore, dispatch_time(DISPATCH_TIME_NOW, kTimeoutNanoseconds));
      state->latencyMs = ElapsedMilliseconds(started, mach_continuous_time());
      if (waitResult != 0) {
        state->error = "timed out waiting for DeviceCheck token";
        return;
      }
      if (failure != nil) {
        state->error = failure.localizedDescription.UTF8String ?: "DeviceCheck token generation failed";
        return;
      }
      if (token == nil) {
        state->error = "DeviceCheck returned no token";
        return;
      }
      NSString *base64 = [token base64EncodedStringWithOptions:0];
      state->tokenBase64 = base64.UTF8String ?: "";
      if (state->tokenBase64.empty()) state->error = "DeviceCheck returned no token";
    } @catch (NSException *exception) {
      state->error = exception.reason.UTF8String ?: "DeviceCheck token generation failed";
    }
  }
}

napi_value MakeString(napi_env env, const std::string &value) {
  napi_value output;
  if (napi_create_string_utf8(env, value.data(), value.size(), &output) != napi_ok) return nullptr;
  return output;
}

void CompleteToken(napi_env env, napi_status status, void *data) {
  auto *state = static_cast<TokenWork *>(data);
  if (status != napi_ok && state->error.empty()) state->error = "DeviceCheck worker failed";

  if (!state->error.empty()) {
    napi_value message = MakeString(env, state->error);
    napi_value error;
    if (message != nullptr && napi_create_error(env, nullptr, message, &error) == napi_ok) {
      napi_reject_deferred(env, state->deferred, error);
    }
  } else {
    napi_value result, supported, latency;
    if (napi_create_object(env, &result) == napi_ok &&
        napi_get_boolean(env, state->supported, &supported) == napi_ok &&
        napi_create_double(env, state->latencyMs, &latency) == napi_ok &&
        napi_set_named_property(env, result, "supported", supported) == napi_ok &&
        napi_set_named_property(env, result, "latencyMs", latency) == napi_ok) {
      bool complete = true;
      if (!state->tokenBase64.empty()) {
        napi_value token = MakeString(env, state->tokenBase64);
        complete = token != nullptr &&
                   napi_set_named_property(env, result, "tokenBase64", token) == napi_ok;
      }
      if (complete) {
        napi_resolve_deferred(env, state->deferred, result);
      } else {
        napi_value message = MakeString(env, "Unable to materialize DeviceCheck result");
        napi_value error;
        if (message != nullptr && napi_create_error(env, nullptr, message, &error) == napi_ok) {
          napi_reject_deferred(env, state->deferred, error);
        }
      }
    } else {
      napi_value message = MakeString(env, "Unable to materialize DeviceCheck result");
      napi_value error;
      if (message != nullptr && napi_create_error(env, nullptr, message, &error) == napi_ok) {
        napi_reject_deferred(env, state->deferred, error);
      }
    }
  }

  napi_delete_async_work(env, state->work);
  delete state;
}

napi_value IsSupported(napi_env env, napi_callback_info) {
  @autoreleasepool {
    bool supported = false;
    @try {
      supported = DCDevice.currentDevice.isSupported;
    } @catch (NSException *) {
      supported = false;
    }
    napi_value result;
    NAPI_CHECK(napi_get_boolean(env, supported, &result));
    return result;
  }
}

napi_value GenerateToken(napi_env env, napi_callback_info) {
  auto *state = new TokenWork();
  napi_value promise, resourceName;
  if (napi_create_promise(env, &state->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "nodex-devicecheck-token", NAPI_AUTO_LENGTH, &resourceName) != napi_ok ||
      napi_create_async_work(env, nullptr, resourceName, ExecuteToken, CompleteToken, state, &state->work) != napi_ok) {
    delete state;
    napi_throw_error(env, nullptr, "Unable to start DeviceCheck token generation");
    return nullptr;
  }
  if (napi_queue_async_work(env, state->work) != napi_ok) {
    napi_delete_async_work(env, state->work);
    delete state;
    napi_throw_error(env, nullptr, "Unable to start DeviceCheck token generation");
    return nullptr;
  }
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"generateToken", nullptr, GenerateToken, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isSupported", nullptr, IsSupported, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  NAPI_CHECK(napi_define_properties(env, exports, 2, properties));
  return exports;
}
} // namespace

NAPI_MODULE(nodex_devicecheck, Init)
