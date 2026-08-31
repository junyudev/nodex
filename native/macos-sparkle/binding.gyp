{
  "variables": {
    "sparkle_framework_parent_dir%": ""
  },
  "targets": [
    {
      "target_name": "nodex_sparkle",
      "sources": [
        "src/nodex_sparkle.mm"
      ],
      "include_dirs": [
        "<(sparkle_framework_parent_dir)/Sparkle.framework/Versions/B/Headers"
      ],
      "defines": [
        "BUILDING_SPARKLE_SOURCES_EXTERNALLY=1"
      ],
      "cflags": [
        "-F<(sparkle_framework_parent_dir)"
      ],
      "cflags_cc": [
        "-F<(sparkle_framework_parent_dir)"
      ],
      "libraries": [
        "-F<(sparkle_framework_parent_dir)",
        "-framework Sparkle"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_ENABLE_MODULES": "YES",
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
        "LD_RUNPATH_SEARCH_PATHS": [
          "@loader_path/../../Frameworks"
        ],
        "MACOSX_DEPLOYMENT_TARGET": "15.0"
      }
    }
  ]
}
