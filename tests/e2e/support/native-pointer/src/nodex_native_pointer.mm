// Test-only probe: delivers a left click to an Electron BrowserWindow through
// AppKit's own event dispatch ([NSApp sendEvent:]), so window hit-testing,
// native window buttons, draggable regions, and first-mouse activation decide
// the outcome exactly as they would for a hardware click. It never moves the
// system cursor and needs no accessibility permission because it runs inside
// the target process.
#include <node_api.h>
#import <AppKit/AppKit.h>

namespace {

napi_value Fail(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

NSWindow *WindowFromHandle(napi_env env, napi_value handle) {
  void *data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok || length < sizeof(void *)) {
    return nil;
  }
  NSView *view = (__bridge NSView *)(*reinterpret_cast<void **>(data));
  return view.window;
}

// click(nativeWindowHandle, x, y): x/y are window content coordinates in points,
// measured from the top-left like CSS pixels at zoom 1.
napi_value Click(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 3) {
    return Fail(env, "click(handle, x, y) requires three arguments");
  }
  double x = 0;
  double y = 0;
  if (napi_get_value_double(env, args[1], &x) != napi_ok ||
      napi_get_value_double(env, args[2], &y) != napi_ok) {
    return Fail(env, "click coordinates must be numbers");
  }
  @autoreleasepool {
    if (!NSThread.isMainThread) return Fail(env, "click must run on the main thread");
    NSWindow *window = WindowFromHandle(env, args[0]);
    if (window == nil) return Fail(env, "native window handle is unavailable");
    NSView *content = window.contentView;
    const CGFloat height = content.bounds.size.height;
    const NSPoint inContent = NSMakePoint(x, content.isFlipped ? y : height - y);
    const NSPoint location = [content convertPoint:inContent toView:nil];
    const NSTimeInterval timestamp = NSProcessInfo.processInfo.systemUptime;
    NSEvent *down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
                                       location:location
                                  modifierFlags:0
                                      timestamp:timestamp
                                   windowNumber:window.windowNumber
                                        context:nil
                                    eventNumber:0
                                     clickCount:1
                                       pressure:1.0];
    NSEvent *up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp
                                     location:location
                                modifierFlags:0
                                    timestamp:timestamp + 0.05
                                 windowNumber:window.windowNumber
                                      context:nil
                                  eventNumber:0
                                   clickCount:1
                                     pressure:0.0];
    if (down == nil || up == nil) return Fail(env, "could not create mouse events");
    // Queue the release first so any tracking loop started by the press ends.
    [NSApp postEvent:up atStart:NO];
    [NSApp sendEvent:down];
  }
  return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value click;
  napi_create_function(env, "click", NAPI_AUTO_LENGTH, Click, nullptr, &click);
  napi_set_named_property(env, exports, "click", click);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
