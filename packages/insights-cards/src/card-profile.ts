import type { IntlShape } from "@formatjs/intl";

import { defineMessage } from "./messages";
import type { ShareCardView } from "./view";

const CLUB_TIERS = [
  {
    tokens: 1e12,
    label: defineMessage({ id: "insights.insightsModel.clubTrillion", defaultMessage: "1T Club" }),
  },
  {
    tokens: 100e9,
    label: defineMessage({
      id: "insights.insightsModel.clubHundredBillion",
      defaultMessage: "100B Club",
    }),
  },
  {
    tokens: 10e9,
    label: defineMessage({
      id: "insights.insightsModel.clubTenBillion",
      defaultMessage: "10B Club",
    }),
  },
  {
    tokens: 1e9,
    label: defineMessage({ id: "insights.insightsModel.clubBillion", defaultMessage: "1B Club" }),
  },
] as const;

/** A fixed mark anyone can verify from their own number; no one is ranked against anyone. */
export function tokenClub<RichText>(tokens: number, intl: IntlShape<RichText>): string | null {
  const tier = CLUB_TIERS.find((tier) => tokens >= tier.tokens);
  return tier ? intl.formatMessage(tier.label) : null;
}

/** What the numbers say about how someone works, strongest signal first. */
export function agentArchetype<RichText>(view: ShareCardView, intl: IntlShape<RichText>): string {
  const totalHours = view.hours.reduce((sum, value) => sum + value, 0);
  const night =
    totalHours === 0
      ? 0
      : view.hours.reduce((sum, value, hour) => sum + (hour >= 22 || hour < 5 ? value : 0), 0) /
        totalHours;
  if (view.peakAgents >= 10)
    return intl.formatMessage({
      id: "insights.insightsModel.orchestrator",
      defaultMessage: "The Orchestrator",
    });
  if (night >= 0.45)
    return intl.formatMessage({
      id: "insights.insightsModel.nightShift",
      defaultMessage: "The Night Shift",
    });
  if (view.messages > 0 && view.tokens / view.messages >= 5e6)
    return intl.formatMessage({
      id: "insights.insightsModel.delegator",
      defaultMessage: "The Delegator",
    });
  if (view.longestStreak >= 30)
    return intl.formatMessage({
      id: "insights.insightsModel.dailyShipper",
      defaultMessage: "The Daily Shipper",
    });
  if (view.models[0] !== undefined && view.models[0].share >= 0.85) {
    return intl.formatMessage(
      { id: "insights.insightsModel.loyalist", defaultMessage: "{model} Loyalist" },
      { model: view.models[0].label },
    );
  }
  return intl.formatMessage({
    id: "insights.insightsModel.builder",
    defaultMessage: "The Builder",
  });
}
