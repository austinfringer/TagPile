export type User = {
  id: string;
  username: string;
  email: string;
  is_admin?: boolean | number;
  created_at: string;
  updated_at: string;
  password_hash?: string;
};

export type RefreshTokenRecord = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  revoked: boolean;
  replaces: string | null;
};

export type InvitationRecord = {
  id: string;
  created_at: string;
  code_hash: string;
  updated_at: string;
  expires_at: string;
  revoked: boolean;
  used: boolean;
  is_admin?: boolean | number;
  issuer_id: string | null;
  claimant_id: string | null;
};

export type JobLifecycleStatus = 'queued' | 'running' | 'complete' | 'error' | 'halted';

export type JobRecord = {
  id: string;
  type: string;
  status: JobLifecycleStatus;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** JSON-encoded options the job was started with. */
  options: string | null;
  /** JSON-encoded snapshot of the job's last reported `JobStatus`. */
  status_data: string | null;
  error: string | null;
};
