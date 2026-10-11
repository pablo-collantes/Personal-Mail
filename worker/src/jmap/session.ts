import { CATEGORIES, CORE, LIMITS, MAIL } from "./protocol";
import { SESSION_STATE } from "./mail";

/** The JMAP Session resource (RFC 8620 §2). URLs are absolute, on the origin the client used. */
export function sessionObject(origin: string, accountId: string, username: string): Record<string, unknown> {
  return {
    capabilities: {
      [CORE]: LIMITS,
      [MAIL]: {},
      [CATEGORIES]: {},
    },
    accounts: {
      [accountId]: {
        name: username,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          [CORE]: {},
          [MAIL]: {
            maxMailboxesPerEmail: 1,
            maxMailboxDepth: 1,
            maxSizeMailboxName: 100,
            maxSizeAttachmentsPerEmail: 0,
            emailQuerySortOptions: ["receivedAt", "sentAt", "size", "from", "subject", "hasKeyword"],
            mayCreateTopLevelMailbox: false,
          },
        },
      },
    },
    primaryAccounts: { [CORE]: accountId, [MAIL]: accountId },
    username,
    apiUrl: `${origin}/jmap/api`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${origin}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: SESSION_STATE,
  };
}
