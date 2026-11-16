const markdownLink = /!?\[([^\]\n]*)\]\([^)\s]*\)/g;

/** Chat search includes the visible link label in a message. */
export const searchableMessageText = (text: string) => text.replace(markdownLink, "$1");
