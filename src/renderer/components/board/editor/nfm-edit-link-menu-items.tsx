import { LinkToolbarExtension } from "@blocknote/core/extensions";
import { KeyboardEvent, useCallback, useState } from "react";
import { useExtension, type LinkToolbarProps } from "./nfm-link-toolbar-deps";
import { normalizeNfmEditorLinkUrl } from "./nfm-link-url";

export type NfmLinkEditorProps = Pick<
  LinkToolbarProps,
  "url" | "text" | "range" | "setToolbarOpen" | "setToolbarPositionFrozen"
>;

export function useNfmLinkEditorState(props: NfmLinkEditorProps) {
  const { editLink } = useExtension(LinkToolbarExtension);
  const { url, text } = props;

  const [currentUrl, setCurrentUrl] = useState<string>(url);
  const [currentText, setCurrentText] = useState<string>(text);

  const [previousLink, setPreviousLink] = useState({ text, url });
  if (previousLink.text !== text || previousLink.url !== url) {
    setPreviousLink({ text, url });
    setCurrentUrl(url);
    setCurrentText(text);
  }

  const submit = useCallback(
    (overrideUrl?: string, overrideText?: string) => {
      const normalizedUrl = normalizeNfmEditorLinkUrl(overrideUrl ?? currentUrl);
      if (!normalizedUrl) return;

      editLink(normalizedUrl, overrideText ?? currentText, props.range.from);
      props.setToolbarOpen?.(false);
      props.setToolbarPositionFrozen?.(false);
    },
    [currentText, currentUrl, editLink, props],
  );

  const handleEnter = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [submit],
  );

  return {
    currentUrl,
    currentText,
    setCurrentUrl,
    setCurrentText,
    submit,
    handleEnter,
  };
}
