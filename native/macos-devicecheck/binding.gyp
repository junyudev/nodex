{
  "targets": [{
    "target_name": "nodex_devicecheck",
    "sources": ["src/nodex_devicecheck.mm"],
    "libraries": ["-framework DeviceCheck", "-framework Foundation"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
      "MACOSX_DEPLOYMENT_TARGET": "15.0"
    }
  }]
}
