Pod::Spec.new do |s|
  s.name = 'PinnedTls'
  s.version = '0.1.0'
  s.summary = 'Runtime leaf certificate pinning for Nodex Mobile'
  s.description = s.summary
  s.license = 'Apache-2.0'
  s.author = 'Nodex'
  s.homepage = 'https://nodex.app'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.exclude_files = 'tests/**/*'
  s.swift_version = '5.9'
end
