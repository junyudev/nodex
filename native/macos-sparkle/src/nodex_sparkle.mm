#include <node_api.h>

#import <AppKit/AppKit.h>
#import "SPUDownloadData.h"
#import "SPUUpdater.h"
#import "SPUUpdaterDelegate.h"
#import "SPUUserDriver.h"
#import "SPUUserUpdateState.h"
#import "SUAppcastItem.h"
#import "SUErrors.h"
#import "SUUpdatePermissionResponse.h"

#include <string>
#include <vector>

static napi_threadsafe_function g_eventSink = nullptr;

struct EventPayload {
  std::string json;
};

static void CallEventSink(napi_env env, napi_value callback, void *, void *data) {
  auto *payload = static_cast<EventPayload *>(data);
  if (env != nullptr && callback != nullptr) {
    napi_value jsonString;
    napi_value event;
    napi_value undefined;
    napi_create_string_utf8(env, payload->json.c_str(), payload->json.size(), &jsonString);
    napi_value global;
    napi_value jsonObject;
    napi_value parseFunction;
    napi_get_global(env, &global);
    napi_get_named_property(env, global, "JSON", &jsonObject);
    napi_get_named_property(env, jsonObject, "parse", &parseFunction);
    napi_call_function(env, jsonObject, parseFunction, 1, &jsonString, &event);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 1, &event, nullptr);
  }
  delete payload;
}

static void EmitEvent(NSDictionary<NSString *, id> *event) {
  if (g_eventSink == nullptr) return;
  NSError *error = nil;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:event options:0 error:&error];
  if (jsonData == nil || error != nil) return;
  NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
  if (json == nil) return;
  auto *payload = new EventPayload{std::string(json.UTF8String)};
  const napi_status status = napi_call_threadsafe_function(
    g_eventSink,
    payload,
    napi_tsfn_nonblocking
  );
  if (status != napi_ok) delete payload;
}

static NSDictionary<NSString *, id> *ErrorEvent(NSError *error) {
  NSString *code = [NSString stringWithFormat:@"%@:%ld", error.domain, (long)error.code];
  return @{
    @"type": @"error",
    @"code": code,
    @"message": error.localizedDescription ?: @"The update operation failed.",
    @"recoverable": @YES,
  };
}

static NSDictionary<NSString *, id> *ItemIdentity(SUAppcastItem *item, NSString *type) {
  NSMutableDictionary<NSString *, id> *event = [@{
    @"type": type,
    @"version": item.displayVersionString ?: item.versionString,
    @"buildVersion": item.versionString,
  } mutableCopy];
  if (item.title != nil) event[@"releaseName"] = item.title;
  if (item.dateString != nil) event[@"releaseDate"] = item.dateString;
  if (item.itemDescription != nil) event[@"releaseNotes"] = item.itemDescription;
  return event;
}

@interface NodexSparkleController : NSObject <SPUUpdaterDelegate, SPUUserDriver>

@property(nonatomic, copy) NSString *feedURLString;
@property(nonatomic, strong) NSBundle *hostBundle;
@property(nonatomic, strong) NSBundle *applicationBundle;
@property(nonatomic, strong, nullable) SPUUpdater *updater;
@property(nonatomic, strong, nullable) SUAppcastItem *availableItem;
@property(nonatomic, copy, nullable) void (^immediateInstallHandler)(void);
@property(nonatomic) BOOL installRequested;
@property(nonatomic) uint64_t expectedBytes;
@property(nonatomic) uint64_t receivedBytes;
@property(nonatomic, copy) NSString *activeCheckKind;

- (instancetype)initWithFeedURLString:(NSString *)feedURLString
                           hostBundle:(NSBundle *)hostBundle
                    applicationBundle:(NSBundle *)applicationBundle;
- (BOOL)start:(NSError **)error;
- (void)checkForUpdatesWithKind:(NSString *)kind;
- (void)installDownloadedUpdate;
- (BOOL)setFeedURLString:(NSString *)feedURLString error:(NSError **)error;

@end

@implementation NodexSparkleController

- (instancetype)initWithFeedURLString:(NSString *)feedURLString
                           hostBundle:(NSBundle *)hostBundle
                    applicationBundle:(NSBundle *)applicationBundle {
  self = [super init];
  if (self != nil) {
    _feedURLString = [feedURLString copy];
    _hostBundle = hostBundle;
    _applicationBundle = applicationBundle;
    _activeCheckKind = @"user";
  }
  return self;
}

- (BOOL)start:(NSError **)error {
  self.updater = [[SPUUpdater alloc]
    initWithHostBundle:self.hostBundle
    applicationBundle:self.applicationBundle
    userDriver:self
    delegate:self];
  return [self.updater startUpdater:error];
}

- (void)checkForUpdatesWithKind:(NSString *)kind {
  self.activeCheckKind = [kind copy];
  self.installRequested = NO;
  self.immediateInstallHandler = nil;
  EmitEvent(@{ @"type": @"check-started", @"kind": self.activeCheckKind });
  if ([kind isEqualToString:@"background"]) {
    [self.updater checkForUpdatesInBackground];
    return;
  }
  [self.updater checkForUpdates];
}

- (void)installDownloadedUpdate {
  self.installRequested = YES;
  self.activeCheckKind = @"user";
  if (self.immediateInstallHandler != nil) {
    EmitEvent(@{ @"type": @"installing" });
    self.immediateInstallHandler();
    return;
  }
  [self.updater checkForUpdates];
}

- (BOOL)setFeedURLString:(NSString *)feedURLString error:(NSError **)error {
  if (self.updater.sessionInProgress || self.availableItem != nil || self.immediateInstallHandler != nil) {
    if (error != nullptr) {
      *error = [NSError errorWithDomain:@"app.jyu.nodex.sparkle"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey: @"Update channel cannot change during an update session."}];
    }
    return NO;
  }
  self.feedURLString = [feedURLString copy];
  self.installRequested = NO;
  self.expectedBytes = 0;
  self.receivedBytes = 0;
  [self.updater resetUpdateCycle];
  return YES;
}

- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
  (void)updater;
  return self.feedURLString;
}

- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request
                              reply:(void (^)(SUUpdatePermissionResponse *))reply {
  (void)request;
  reply([[SUUpdatePermissionResponse alloc]
    initWithAutomaticUpdateChecks:NO
    automaticUpdateDownloading:@NO
    sendSystemProfile:NO]);
}

- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
  (void)updater;
  self.availableItem = item;
  if ([self.activeCheckKind isEqualToString:@"background"]) {
    EmitEvent(ItemIdentity(item, @"update-found"));
  }
}

- (void)updater:(SPUUpdater *)updater
    willDownloadUpdate:(SUAppcastItem *)item
           withRequest:(NSMutableURLRequest *)request {
  (void)updater;
  (void)request;
  if ([self.activeCheckKind isEqualToString:@"background"]) {
    EmitEvent(@{
      @"type": @"download-started",
      @"expectedBytes": item.contentLength > 0 ? @(item.contentLength) : [NSNull null],
    });
  }
}

- (void)updater:(SPUUpdater *)updater didDownloadUpdate:(SUAppcastItem *)item {
  (void)updater;
  if ([self.activeCheckKind isEqualToString:@"background"] && item.contentLength > 0) {
    EmitEvent(@{
      @"type": @"download-progress",
      @"receivedBytes": @(item.contentLength),
      @"expectedBytes": @(item.contentLength),
    });
  }
}

- (BOOL)updater:(SPUUpdater *)updater
    willInstallUpdateOnQuit:(SUAppcastItem *)item
 immediateInstallationBlock:(void (^)(void))immediateInstallHandler {
  (void)updater;
  self.availableItem = item;
  self.immediateInstallHandler = [immediateInstallHandler copy];
  EmitEvent(ItemIdentity(item, @"update-ready"));
  return YES;
}

- (void)updaterDidNotFindUpdate:(SPUUpdater *)updater error:(NSError *)error {
  (void)updater;
  if (![self.activeCheckKind isEqualToString:@"background"]) return;
  NSNumber *reasonValue = error.userInfo[SPUNoUpdateFoundReasonKey];
  const SPUNoUpdateFoundReason reason = reasonValue != nil
    ? (SPUNoUpdateFoundReason)reasonValue.integerValue
    : SPUNoUpdateFoundReasonUnknown;
  if (
    reason == SPUNoUpdateFoundReasonOnLatestVersion
    || reason == SPUNoUpdateFoundReasonOnNewerThanLatestVersion
  ) {
    NSString *version = [self.hostBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"";
    EmitEvent(@{ @"type": @"up-to-date", @"version": version });
  } else {
    EmitEvent(ErrorEvent(error));
  }
}

- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
  (void)updater;
  if (
    [self.activeCheckKind isEqualToString:@"background"]
    && error.code != SUNoUpdateError
  ) {
    EmitEvent(ErrorEvent(error));
  }
}

- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  (void)cancellation;
}

- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)appcastItem
                                 state:(SPUUserUpdateState *)state
                                 reply:(void (^)(SPUUserUpdateChoice))reply {
  self.availableItem = appcastItem;
  EmitEvent(ItemIdentity(appcastItem, @"update-found"));
  if (appcastItem.informationOnlyUpdate) {
    EmitEvent(@{
      @"type": @"error",
      @"code": @"information-only-update",
      @"message": @"This update must be installed from the Nodex website.",
      @"recoverable": @YES,
    });
    reply(SPUUserUpdateChoiceDismiss);
    return;
  }
  if (state.stage == SPUUserUpdateStageNotDownloaded) {
    reply(SPUUserUpdateChoiceInstall);
    return;
  }
  if (state.stage == SPUUserUpdateStageDownloaded) {
    EmitEvent(ItemIdentity(appcastItem, @"update-ready"));
    const BOOL shouldInstall = self.installRequested;
    self.installRequested = NO;
    if (shouldInstall) EmitEvent(@{ @"type": @"installing" });
    reply(shouldInstall ? SPUUserUpdateChoiceInstall : SPUUserUpdateChoiceDismiss);
    return;
  }
  const BOOL shouldInstall = self.installRequested;
  self.installRequested = NO;
  if (shouldInstall) {
    EmitEvent(@{ @"type": @"installing" });
  } else {
    EmitEvent(ItemIdentity(appcastItem, @"update-ready"));
  }
  reply(shouldInstall ? SPUUserUpdateChoiceInstall : SPUUserUpdateChoiceDismiss);
}

- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {
  (void)downloadData;
}

- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {
  (void)error;
}

- (void)showUpdateNotFoundWithError:(NSError *)error
                    acknowledgement:(void (^)(void))acknowledgement {
  NSNumber *reasonValue = error.userInfo[SPUNoUpdateFoundReasonKey];
  const SPUNoUpdateFoundReason reason = reasonValue != nil
    ? (SPUNoUpdateFoundReason)reasonValue.integerValue
    : SPUNoUpdateFoundReasonUnknown;
  if (
    reason == SPUNoUpdateFoundReasonOnLatestVersion
    || reason == SPUNoUpdateFoundReasonOnNewerThanLatestVersion
  ) {
    NSString *version = [self.hostBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"";
    EmitEvent(@{ @"type": @"up-to-date", @"version": version });
  } else {
    EmitEvent(ErrorEvent(error));
  }
  acknowledgement();
}

- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  EmitEvent(ErrorEvent(error));
  acknowledgement();
}

- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  (void)cancellation;
  self.expectedBytes = 0;
  self.receivedBytes = 0;
  EmitEvent(@{ @"type": @"download-started", @"expectedBytes": [NSNull null] });
}

- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)expectedContentLength {
  self.expectedBytes = expectedContentLength;
  EmitEvent(@{ @"type": @"download-started", @"expectedBytes": @(expectedContentLength) });
}

- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
  self.receivedBytes += length;
  EmitEvent(@{
    @"type": @"download-progress",
    @"receivedBytes": @(self.receivedBytes),
    @"expectedBytes": self.expectedBytes > 0 ? @(self.expectedBytes) : [NSNull null],
  });
}

- (void)showDownloadDidStartExtractingUpdate {
  if (self.expectedBytes > 0) {
    EmitEvent(@{
      @"type": @"download-progress",
      @"receivedBytes": @(self.expectedBytes),
      @"expectedBytes": @(self.expectedBytes),
    });
  }
}

- (void)showExtractionReceivedProgress:(double)progress {
  (void)progress;
}

- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  if (self.availableItem != nil) {
    EmitEvent(ItemIdentity(self.availableItem, @"update-ready"));
  } else {
    EmitEvent(@{ @"type": @"update-ready", @"version": @"", @"buildVersion": @"" });
  }
  const BOOL shouldInstall = self.installRequested;
  self.installRequested = NO;
  if (shouldInstall) EmitEvent(@{ @"type": @"installing" });
  reply(shouldInstall ? SPUUserUpdateChoiceInstall : SPUUserUpdateChoiceDismiss);
}

- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)applicationTerminated
                           retryTerminatingApplication:(void (^)(void))retryTerminatingApplication {
  (void)applicationTerminated;
  (void)retryTerminatingApplication;
  EmitEvent(@{ @"type": @"installing" });
}

- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched
                         acknowledgement:(void (^)(void))acknowledgement {
  (void)relaunched;
  acknowledgement();
}

- (void)dismissUpdateInstallation {
}

- (void)showUpdateInFocus {
}

@end

static NodexSparkleController *g_controller = nil;

static bool RequireMainThread(napi_env env) {
  if ([NSThread isMainThread]) return true;
  napi_throw_error(env, "sparkle-main-thread-required", "Sparkle must be called from Electron's main thread.");
  return false;
}

static bool ReadStringProperty(
  napi_env env,
  napi_value object,
  const char *name,
  std::string *output
) {
  napi_value value;
  napi_valuetype type;
  bool hasProperty = false;
  napi_has_named_property(env, object, name, &hasProperty);
  if (!hasProperty) {
    napi_throw_type_error(env, nullptr, name);
    return false;
  }
  napi_get_named_property(env, object, name, &value);
  napi_typeof(env, value, &type);
  if (type != napi_string) {
    napi_throw_type_error(env, nullptr, name);
    return false;
  }
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::vector<char> buffer(length + 1);
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  output->assign(buffer.data(), length);
  return true;
}

static bool ReadStringValue(napi_env env, napi_value value, std::string *output) {
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type != napi_string) {
    napi_throw_type_error(env, nullptr, "Sparkle check kind must be background or user.");
    return false;
  }
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::vector<char> buffer(length + 1);
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  output->assign(buffer.data(), length);
  return true;
}

static napi_value Initialize(napi_env env, napi_callback_info info) {
  if (!RequireMainThread(env)) return nullptr;
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 2 || g_controller != nil || g_eventSink != nullptr) {
    napi_throw_error(env, "sparkle-already-initialized", "Sparkle binding can be initialized exactly once before disposal.");
    return nullptr;
  }
  napi_valuetype callbackType;
  napi_typeof(env, argv[1], &callbackType);
  if (callbackType != napi_function) {
    napi_throw_type_error(env, nullptr, "Sparkle event sink must be a function.");
    return nullptr;
  }

  std::string feedURL;
  std::string hostBundlePath;
  std::string applicationBundlePath;
  if (
    !ReadStringProperty(env, argv[0], "feedUrl", &feedURL)
    || !ReadStringProperty(env, argv[0], "hostBundlePath", &hostBundlePath)
    || !ReadStringProperty(env, argv[0], "applicationBundlePath", &applicationBundlePath)
  ) return nullptr;

  napi_value resourceName;
  napi_create_string_utf8(env, "Nodex Sparkle event sink", NAPI_AUTO_LENGTH, &resourceName);
  const napi_status createStatus = napi_create_threadsafe_function(
    env,
    argv[1],
    nullptr,
    resourceName,
    0,
    1,
    nullptr,
    nullptr,
    nullptr,
    CallEventSink,
    &g_eventSink
  );
  if (createStatus != napi_ok) {
    g_eventSink = nullptr;
    napi_throw_error(env, "sparkle-event-sink-failed", "Could not create the Sparkle event sink.");
    return nullptr;
  }

  @autoreleasepool {
    NSString *hostPath = [NSString stringWithUTF8String:hostBundlePath.c_str()];
    NSString *applicationPath = [NSString stringWithUTF8String:applicationBundlePath.c_str()];
    NSBundle *hostBundle = [NSBundle bundleWithPath:hostPath];
    NSBundle *applicationBundle = [NSBundle bundleWithPath:applicationPath];
    if (hostBundle == nil || applicationBundle == nil) {
      napi_release_threadsafe_function(g_eventSink, napi_tsfn_abort);
      g_eventSink = nullptr;
      napi_throw_error(env, "sparkle-invalid-bundle", "Sparkle host and application paths must be valid bundles.");
      return nullptr;
    }
    g_controller = [[NodexSparkleController alloc]
      initWithFeedURLString:[NSString stringWithUTF8String:feedURL.c_str()]
      hostBundle:hostBundle
      applicationBundle:applicationBundle];
    NSError *startError = nil;
    if (![g_controller start:&startError]) {
      g_controller = nil;
      napi_release_threadsafe_function(g_eventSink, napi_tsfn_abort);
      g_eventSink = nullptr;
      napi_throw_error(env, "sparkle-start-failed", startError.localizedDescription.UTF8String);
      return nullptr;
    }

    napi_value result;
    napi_create_object(env, &result);
    NSBundle *sparkleBundle = [NSBundle bundleForClass:[SPUUpdater class]];
    NSString *sparkleVersion = [sparkleBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"unknown";
    napi_value versionValue;
    napi_create_string_utf8(env, sparkleVersion.UTF8String, NAPI_AUTO_LENGTH, &versionValue);
    napi_set_named_property(env, result, "sparkleVersion", versionValue);
    napi_value architectureValue;
#if defined(__arm64__)
    napi_create_string_utf8(env, "arm64", NAPI_AUTO_LENGTH, &architectureValue);
#else
#error Unsupported macOS architecture
#endif
    napi_set_named_property(env, result, "architecture", architectureValue);
    return result;
  }
}

static napi_value CheckForUpdates(napi_env env, napi_callback_info info) {
  if (!RequireMainThread(env)) return nullptr;
  if (g_controller == nil) {
    napi_throw_error(env, "sparkle-not-initialized", "Sparkle binding is not initialized.");
    return nullptr;
  }
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1) {
    napi_throw_type_error(env, nullptr, "Sparkle check kind must be background or user.");
    return nullptr;
  }
  std::string kind;
  if (!ReadStringValue(env, argv[0], &kind)) return nullptr;
  if (kind != "background" && kind != "user") {
    napi_throw_type_error(env, nullptr, "Sparkle check kind must be background or user.");
    return nullptr;
  }
  [g_controller checkForUpdatesWithKind:[NSString stringWithUTF8String:kind.c_str()]];
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value InstallDownloadedUpdate(napi_env env, napi_callback_info info) {
  (void)info;
  if (!RequireMainThread(env)) return nullptr;
  if (g_controller == nil) {
    napi_throw_error(env, "sparkle-not-initialized", "Sparkle binding is not initialized.");
    return nullptr;
  }
  [g_controller installDownloadedUpdate];
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value SetFeedUrl(napi_env env, napi_callback_info info) {
  if (!RequireMainThread(env)) return nullptr;
  if (g_controller == nil) {
    napi_throw_error(env, "sparkle-not-initialized", "Sparkle binding is not initialized.");
    return nullptr;
  }
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string feedURL;
  if (argc != 1 || !ReadStringValue(env, argv[0], &feedURL)) return nullptr;
  @autoreleasepool {
    NSError *error = nil;
    if (![g_controller setFeedURLString:[NSString stringWithUTF8String:feedURL.c_str()] error:&error]) {
      napi_throw_error(env, "sparkle-session-in-progress", error.localizedDescription.UTF8String);
      return nullptr;
    }
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value Dispose(napi_env env, napi_callback_info info) {
  (void)info;
  if (!RequireMainThread(env)) return nullptr;
  g_controller = nil;
  if (g_eventSink != nullptr) {
    napi_release_threadsafe_function(g_eventSink, napi_tsfn_abort);
    g_eventSink = nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"initialize", nullptr, Initialize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkForUpdates", nullptr, CheckForUpdates, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"installDownloadedUpdate", nullptr, InstallDownloadedUpdate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setFeedUrl", nullptr, SetFeedUrl, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
