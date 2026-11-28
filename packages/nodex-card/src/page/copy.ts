import type { Locale } from "../locale";

interface PageCopy {
  title: string;
  cards: string;
  skyline: string;
  receipt: string;
  cardAlt: (name: string, summary: string) => string;
  copy: string;
  save: string;
  post: string;
  name: string;
  optional: string;
  showCost: string;
  theme: string;
  dark: string;
  light: string;
  language: string;
  privacy: string;
  copied: string;
  saved: string;
  copiedForPost: string;
  failed: string;
}

export const pageCopy: Record<Locale, PageCopy> = {
  "en-US": {
    title: "Nodex Insights",
    cards: "Cards to share",
    skyline: "Skyline",
    receipt: "Receipt",
    cardAlt: (name, summary) => `${name} card: ${summary}`,
    copy: "Copy image",
    save: "Save PNG",
    post: "Post on X",
    name: "Name on card",
    optional: "Optional",
    showCost: "Show cost",
    theme: "Theme",
    dark: "Dark",
    light: "Light",
    language: "Language",
    privacy: "Made on this device. Nothing is uploaded unless you post it.",
    copied: "Image copied",
    saved: "Card saved",
    copiedForPost: "Image copied. Paste it into your post.",
    failed: "Could not make the image",
  },
  "zh-CN": {
    title: "Nodex 洞察",
    cards: "可分享的卡片",
    skyline: "天际线",
    receipt: "账单",
    cardAlt: (name, summary) => `${name}卡片：${summary}`,
    copy: "复制图片",
    save: "保存 PNG",
    post: "发布到 X",
    name: "卡片上的名字",
    optional: "选填",
    showCost: "显示费用",
    theme: "主题",
    dark: "深色",
    light: "浅色",
    language: "语言",
    privacy: "卡片在此设备上生成。只有发布时才会上传。",
    copied: "已复制图片",
    saved: "已保存卡片",
    copiedForPost: "已复制图片。请将其粘贴到帖子中。",
    failed: "无法生成图片",
  },
};
