#include <node_api.h>
#include <cmath>
#include <vector>
#import <AppKit/AppKit.h>

namespace {
constexpr NSUInteger kFormatLimit = 8 * 1024 * 1024;
constexpr NSUInteger kTotalLimit = 16 * 1024 * 1024;
constexpr NSUInteger kFileLimit = 64;
constexpr NSUInteger kPathLimit = 16 * 1024;

#define NAPI_CHECK(call) \
  if ((call) != napi_ok) { \
    napi_throw_error(env, nullptr, "Clipboard bridge argument or allocation failed"); \
    return nullptr; \
  }

napi_value Fail(napi_env env, const char *reason) {
  napi_throw_error(env, reason, reason);
  return nullptr;
}

napi_value String(napi_env env, NSString *value) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  napi_value result;
  NAPI_CHECK(napi_create_string_utf8(env, static_cast<const char *>(data.bytes), data.length, &result));
  return result;
}

NSString *InputString(napi_env env, napi_value input) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, input, nullptr, 0, &length) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Clipboard presentation must be a string");
    return nil;
  }
  if (length > kFormatLimit) {
    Fail(env, "too_large");
    return nil;
  }
  std::vector<char> bytes(length + 1);
  if (napi_get_value_string_utf8(env, input, bytes.data(), bytes.size(), &length) != napi_ok) {
    Fail(env, "invalid_payload");
    return nil;
  }
  return [[NSString alloc] initWithBytes:bytes.data() length:length encoding:NSUTF8StringEncoding];
}

// AppKit may materialize a foreign provider's NSData before its size can be inspected.
// The limits bound data retained/decoded here, not the provider's allocation.
napi_value Read(napi_env env, napi_callback_info) {
  @autoreleasepool {
    @try {
      if (!NSThread.isMainThread) return Fail(env, "unavailable");
      NSPasteboard *board = NSPasteboard.generalPasteboard;
      const NSInteger generation = board.changeCount;
      napi_value result, generationValue, fileUrls;
      NAPI_CHECK(napi_create_object(env, &result));
      NAPI_CHECK(napi_create_double(env, generation, &generationValue));
      NAPI_CHECK(napi_set_named_property(env, result, "generation", generationValue));
      NSUInteger total = 0;
      NSArray<NSString *> *types = @[NSPasteboardTypeHTML, NSPasteboardTypeString, @"text/markdown"];
      const char *keys[] = {"html", "text", "markdown"};
      for (NSUInteger index = 0; index < types.count; ++index) {
        NSData *data = [board dataForType:types[index]];
        if (!data) continue;
        total += data.length;
        if (data.length > kFormatLimit || total > kTotalLimit) return Fail(env, "too_large");
        NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!value) return Fail(env, "invalid_payload");
        napi_value string = String(env, value);
        if (!string) return nullptr;
        NAPI_CHECK(napi_set_named_property(env, result, keys[index], string));
      }
      NSArray<NSPasteboardItem *> *items = board.pasteboardItems;
      if (items.count > kFileLimit) return Fail(env, "too_large");
      NAPI_CHECK(napi_create_array(env, &fileUrls));
      uint32_t index = 0;
      for (NSPasteboardItem *item in items) {
        NSData *data = [item dataForType:NSPasteboardTypeFileURL];
        if (!data) continue;
        total += data.length;
        if (data.length > kPathLimit || total > kTotalLimit) return Fail(env, "too_large");
        NSString *url = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!url) return Fail(env, "invalid_payload");
        napi_value string = String(env, url);
        if (!string) return nullptr;
        NAPI_CHECK(napi_set_element(env, fileUrls, index++, string));
      }
      NAPI_CHECK(napi_set_named_property(env, result, "fileUrls", fileUrls));
      // Replacing the board during a promised-data read must never mix generations.
      if (board.changeCount != generation) return Fail(env, "inconsistent_read");
      return result;
    } @catch (NSException *) {
      return Fail(env, "unavailable");
    }
  }
}

napi_value Update(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    @try {
      if (!NSThread.isMainThread) return Fail(env, "unavailable");
      size_t argc = 3;
      napi_value args[3];
      NAPI_CHECK(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
      if (argc < 2) return Fail(env, "invalid_payload");
      double rawGeneration;
      NAPI_CHECK(napi_get_value_double(env, args[0], &rawGeneration));
      if (!std::isfinite(rawGeneration) || rawGeneration < 0 ||
          std::floor(rawGeneration) != rawGeneration || rawGeneration > 9007199254740991.0) {
        return Fail(env, "invalid_payload");
      }
      NSString *text = InputString(env, args[1]);
      if (!text) return nullptr;
      NSString *html = nil;
      if (argc == 3) {
        napi_valuetype type;
        NAPI_CHECK(napi_typeof(env, args[2], &type));
        if (type != napi_undefined) {
          html = InputString(env, args[2]);
          if (!html) return nullptr;
        }
      }
      const NSInteger expected = static_cast<NSInteger>(rawGeneration);
      NSPasteboard *board = NSPasteboard.generalPasteboard;
      if (board.changeCount != expected) return String(env, @"superseded");
      // Do not clear, declareTypes, addTypes, or reconstruct Chromium's private formats.
      // AppKit rejects each setData if another process took ownership even between this
      // generation check and the setter. Same-process newer copies are fenced by generation.
      if (![board.types containsObject:NSPasteboardTypeString] ||
          (html && ![board.types containsObject:NSPasteboardTypeHTML])) {
        return String(env, @"write_failed");
      }
      if (![board setString:text forType:NSPasteboardTypeString]) return String(env, @"superseded");
      // HTML is the publication marker and is updated last. This is conditional enhancement,
      // not an atomic multi-format replacement. A partial enhancement never deletes the source.
      if (html && ![board setString:html forType:NSPasteboardTypeHTML]) return String(env, @"superseded");
      if (board.changeCount != expected) return String(env, @"superseded");
      if (![[board stringForType:NSPasteboardTypeString] isEqualToString:text] ||
          (html && ![[board stringForType:NSPasteboardTypeHTML] isEqualToString:html])) {
        return String(env, @"readback_mismatch");
      }
      if (board.changeCount != expected) return String(env, @"superseded");
      return String(env, @"written");
    } @catch (NSException *) {
      return String(env, @"write_failed");
    }
  }
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"update", nullptr, Update, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  NAPI_CHECK(napi_define_properties(env, exports, 2, properties));
  return exports;
}
} // namespace

NAPI_MODULE(nodex_clipboard, Init)
