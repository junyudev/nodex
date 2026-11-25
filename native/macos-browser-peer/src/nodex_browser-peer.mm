#include <node_api.h>
#include <bsm/libbsm.h>
#include <libproc.h>
#include <sys/socket.h>
#include <sys/un.h>
#import <AppKit/AppKit.h>
#import <Security/Security.h>

namespace {

bool ProcessInfo(pid_t pid, proc_bsdinfo &info) {
  return pid > 1 && proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info);
}

bool SameProcess(const proc_bsdinfo &first, const proc_bsdinfo &second) {
  return first.pbi_pid == second.pbi_pid && first.pbi_ppid == second.pbi_ppid &&
         first.pbi_start_tvsec == second.pbi_start_tvsec &&
         first.pbi_start_tvusec == second.pbi_start_tvusec;
}

NSString *ExecutablePath(pid_t pid) {
  char name[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(pid, name, sizeof(name)) <= 0) return nil;
  return [[NSFileManager defaultManager] stringWithFileSystemRepresentation:name length:strlen(name)];
}

NSDictionary *BrowserIdentity(int fd) {
  audit_token_t token{};
  socklen_t size = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) != 0 || size != sizeof(token)) {
    return nil;
  }

  NSData *audit = [NSData dataWithBytes:&token length:sizeof(token)];
  SecCodeRef peer = nullptr;
  if (SecCodeCopyGuestWithAttributes(nullptr, (__bridge CFDictionaryRef)@{
        (__bridge NSString *)kSecGuestAttributeAudit: audit
      }, kSecCSDefaultFlags, &peer) != errSecSuccess) return nil;
  CFRelease(peer);

  const pid_t peerPid = audit_token_to_pid(token);
  proc_bsdinfo connection{};
  if (!ProcessInfo(peerPid, connection)) return nil;
  pid_t ancestorPid = static_cast<pid_t>(connection.pbi_ppid);
  NSString *application = nil;
  proc_bsdinfo chain[4]{};

  // Chromium can launch through a helper inside its app. Follow only that app's process chain.
  for (int depth = 0; depth < 4; ++depth) {
    proc_bsdinfo ancestor{};
    if (!ProcessInfo(ancestorPid, ancestor) || ancestor.pbi_uid != connection.pbi_uid) return nil;
    chain[depth] = ancestor;
    NSString *executable = ExecutablePath(ancestorPid);
    if (!executable) return nil;
    NSRange boundary = [executable rangeOfString:@".app/Contents/"];
    if (boundary.location == NSNotFound) return nil;
    NSString *bundlePath = [executable substringToIndex:boundary.location + 4];
    if (application && ![application isEqualToString:bundlePath]) return nil;
    application = bundlePath;
    NSBundle *bundle = [NSBundle bundleWithPath:bundlePath];
    if (![bundle.executablePath isEqualToString:executable]) {
      ancestorPid = static_cast<pid_t>(ancestor.pbi_ppid);
      continue;
    }

    SecCodeRef code = nullptr;
    if (SecCodeCopyGuestWithAttributes(nullptr, (__bridge CFDictionaryRef)@{
          (__bridge NSString *)kSecGuestAttributePid: @(ancestorPid)
        }, kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
    CFDictionaryRef info = nullptr;
    SecRequirementRef appleSigned = nullptr;
    if (SecRequirementCreateWithString(CFSTR("anchor apple generic"), kSecCSDefaultFlags,
                                       &appleSigned) != errSecSuccess) {
      CFRelease(code);
      return nil;
    }
    const OSStatus status = SecCodeCheckValidity(code, kSecCSDefaultFlags, appleSigned);
    CFRelease(appleSigned);
    if (status == errSecSuccess) {
      SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
    }
    CFRelease(code);
    if (!info) return nil;
    NSDictionary *signature = CFBridgingRelease(info);
    NSString *bundleId = signature[(__bridge NSString *)kSecCodeInfoIdentifier];
    NSString *teamId = signature[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
    proc_bsdinfo currentPeer{};
    if (!teamId.length || ![bundleId isEqualToString:bundle.bundleIdentifier] ||
        !ProcessInfo(peerPid, currentPeer) || !SameProcess(connection, currentPeer)) return nil;
    for (int index = 0; index <= depth; ++index) {
      proc_bsdinfo current{};
      if (!ProcessInfo(chain[index].pbi_pid, current) || !SameProcess(chain[index], current)) return nil;
    }
    SecCodeRef currentCode = nullptr;
    if (SecCodeCopyGuestWithAttributes(nullptr, (__bridge CFDictionaryRef)@{
          (__bridge NSString *)kSecGuestAttributeAudit: audit
        }, kSecCSDefaultFlags, &currentCode) != errSecSuccess) return nil;
    CFRelease(currentCode);

    NSString *iconName = [bundle objectForInfoDictionaryKey:@"CFBundleIconFile"];
    NSString *iconPath = [iconName isKindOfClass:NSString.class]
        ? [bundle pathForResource:iconName.stringByDeletingPathExtension ofType:@"icns"] : nil;
    return @{@"bundleId": bundleId, @"teamId": teamId, @"iconPath": iconPath ?: @""};
  }
  return nil;
}

napi_value ReadBrowserIdentity(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value result;
    napi_get_null(env, &result);
    size_t argc = 1;
    napi_value argv[1];
    int32_t fd;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) return result;
    NSDictionary *identity = BrowserIdentity(fd);
    if (!identity) return result;
    if (napi_create_object(env, &result) != napi_ok) return nullptr;
    for (NSString *key in identity) {
      napi_value value;
      if (napi_create_string_utf8(env, [identity[key] UTF8String], NAPI_AUTO_LENGTH, &value) != napi_ok ||
          napi_set_named_property(env, result, key.UTF8String, value) != napi_ok) return nullptr;
    }
    return result;
  }
}

napi_value IsBrowserRunning(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1, length = 0;
    napi_value argv[1], result;
    char bundleId[256];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok ||
        length == 0 || length >= sizeof(bundleId) ||
        napi_get_value_string_utf8(env, argv[0], bundleId, sizeof(bundleId), &length) != napi_ok ||
        strlen(bundleId) != length) {
      napi_get_null(env, &result);
      return result;
    }
    NSString *identifier = [NSString stringWithUTF8String:bundleId];
    NSArray<NSRunningApplication *> *apps = identifier
        ? [NSRunningApplication runningApplicationsWithBundleIdentifier:identifier] : nil;
    napi_get_boolean(env, apps.count != 0, &result);
    return result;
  }
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"readBrowserIdentity", nullptr, ReadBrowserIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isBrowserRunning", nullptr, IsBrowserRunning, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  return napi_define_properties(env, exports, 2, methods) == napi_ok ? exports : nullptr;
}
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
