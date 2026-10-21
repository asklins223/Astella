

/** 凭据存储的能力；实现把凭据落在 userData 的本地文件里。 */
export type SessionCredentialStore = {
    /** Synchronous peek used by the runtime snapshot, before any adoption. */
    hasStored(): boolean;
    load(): Promise<string | null>;
    save(token: string): Promise<void>;
    clear(): Promise<void>;
  };
