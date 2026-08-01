import { CHECKSUMS } from "./checksum";
import { i18n as I18N } from "./i18n";
import { landingMediaBudget, landingMediaNames, landingMediaStatus } from "./media";
import { PUBLIC_ROUTES } from "./routes";

export const CONSTANT = {
  I18N,
  CHECKSUMS,
  LANDING_MEDIA: {
    budget: landingMediaBudget,
    names: landingMediaNames,
    status: landingMediaStatus,
  },
  PUBLIC_ROUTES,
};
