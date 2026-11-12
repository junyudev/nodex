// A single-target Xcode project with deliberately stale template version settings.
export const projectFixture = `// !$*UTF8*$!
{
  archiveVersion = 1;
  objectVersion = 54;
  objects = {
    /* Begin PBXProject section */
    PROJECT = { isa = PBXProject; mainGroup = ROOT; productRefGroup = PRODUCTS;
      targets = (APP /* Nodex */,); buildConfigurationList = PROJECT_CONFIGS; attributes = {}; };
    /* End PBXProject section */
    /* Begin PBXGroup section */
    ROOT = { isa = PBXGroup; children = (PRODUCTS /* Products */,); sourceTree = "<group>"; };
    PRODUCTS = { isa = PBXGroup; name = Products; children = (); sourceTree = "<group>"; };
    /* End PBXGroup section */
    /* Begin PBXNativeTarget section */
    APP = { isa = PBXNativeTarget; name = Nodex; productName = Nodex;
      productType = "com.apple.product-type.application"; buildConfigurationList = APP_CONFIGS;
      buildPhases = (); dependencies = (); buildRules = (); };
    /* End PBXNativeTarget section */
    /* Begin XCConfigurationList section */
    APP_CONFIGS = { isa = XCConfigurationList; buildConfigurations = (APP_DEBUG /* Debug */, APP_RELEASE /* Release */,); };
    PROJECT_CONFIGS = { isa = XCConfigurationList; buildConfigurations = (PROJECT_DEBUG /* Debug */, PROJECT_RELEASE /* Release */,); };
    /* End XCConfigurationList section */
    /* Begin XCBuildConfiguration section */
    APP_DEBUG = { isa = XCBuildConfiguration; name = Debug; buildSettings = {
      IPHONEOS_DEPLOYMENT_TARGET = 17.0; MARKETING_VERSION = 1.0; CURRENT_PROJECT_VERSION = 1; }; };
    APP_RELEASE = { isa = XCBuildConfiguration; name = Release; buildSettings = {
      IPHONEOS_DEPLOYMENT_TARGET = 17.0; MARKETING_VERSION = 1.0; CURRENT_PROJECT_VERSION = 1; }; };
    PROJECT_DEBUG = { isa = XCBuildConfiguration; name = Debug; buildSettings = { IPHONEOS_DEPLOYMENT_TARGET = 16.4; }; };
    PROJECT_RELEASE = { isa = XCBuildConfiguration; name = Release; buildSettings = { IPHONEOS_DEPLOYMENT_TARGET = 16.4; }; };
    /* End XCBuildConfiguration section */
  };
  rootObject = PROJECT;
}
`;
