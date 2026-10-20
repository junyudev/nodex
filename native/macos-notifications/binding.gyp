{
  "targets": [{
    "target_name": "nodex_notifications",
    "sources": ["src/nodex_notifications.mm"],
    "libraries": ["-framework Foundation", "-framework UserNotifications"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "GCC_SYMBOLS_PRIVATE_EXTERN": "YES"
    },
    "target_conditions": [["OS=='mac'", {
      "xcode_settings": { "MACOSX_DEPLOYMENT_TARGET": "15.0" }
    }]]
  }]
}
