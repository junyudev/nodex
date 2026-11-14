import { writeTextToClipboard } from "@/lib/clipboard";
import { toast } from "@/components/ui/toast";

/** Copies text and reports the outcome the way every copy action in a menu does. */
export async function copyTextWithFeedback(
  value: string,
  successMessage: string,
  failureMessage: string,
): Promise<void> {
  if (await writeTextToClipboard(value)) {
    toast.success(successMessage);
    return;
  }
  toast.danger(failureMessage);
}
