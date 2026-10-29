/**
 * Curated MCP extras keyed by operationId, for guidance that is about using a tool well rather than about the API itself.
 * Keep it small: anything that should apply to a new API feature belongs in the spec's `x-mcp` extension, which wins over
 * this file when both set the same field.
 */
export interface OverlayEntry {
  /** Appended to the tool description (ignored when the operation has `x-mcp.description`). */
  description?: string;
  /** Hide the operation from MCP (ignored when the operation has `x-mcp.hidden`). */
  hidden?: boolean;
}

export const overlay: Record<string, OverlayEntry> = {
  sendEmail: {
    description:
      '`from` must be on a verified domain (e.g. "Acme <hi@acme.com>"); call list_domains to find one. Provide `html`, `text` or both. ' +
      "Send to delivered@test.spacepost.dev (or bounced@ / complained@) to test without sending real mail. " +
      "Delivered email cannot be recalled: confirm recipients and content with the user when unsure. " +
      "Pass `idempotency_key` when retrying so the email is not sent twice.",
  },
  sendBatchEmails: {
    description: "Put the emails in `body` as an array. Prefer send_email for a single message.",
  },
  createDomain: {
    description:
      "The response lists the DNS records (DKIM CNAMEs, MAIL FROM MX and SPF TXT) the user must add at their DNS provider; " +
      "afterwards call verify_domain and then get_domain to see the new status. DNS changes can take minutes to hours.",
  },
  sendBroadcast: {
    description:
      "Sends to every subscribed contact in the audience. Run get_broadcast_readiness first and confirm with the user.",
  },
};
