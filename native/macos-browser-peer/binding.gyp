{
  "targets": [{
    "target_name": "nodex_browser_peer",
    "sources": ["src/nodex_browser-peer.mm"],
    "libraries": ["-framework AppKit", "-framework Security", "-lbsm"],
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
