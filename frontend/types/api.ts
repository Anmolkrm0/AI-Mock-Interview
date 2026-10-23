export type InterviewStatus =
  | "created"
  | "preparing"
  | "ready"
  | "connecting"
  | "in_progress"
  | "paused"
  | "finalizing"
  | "evaluating"
  | "completed"
  | "failed"
  | "cancelled";

export type Rigor = "standard" | "target_bar" | "stress_test";
export type Duration = 10 | 20 | 30 | 45;
export type RecordingMode = "video" | "audio" | "none";

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  request_id?: string;
  details?: Record<string, unknown>;
}

export interface DocumentOut {
  id: string;
  document_type: "resume" | "job_description";
  file_name: string | null;
  parsing_status: "pending" | "extracting" | "parsed" | "failed";
  parsing_error: string | null;
  extracted_data: Record<string, unknown> | null;
  character_count: number;
  created_at: string;
}

export interface ResumeData {
  candidate_name?: string | null;
  headline?: string | null;
  total_experience_years?: number | null;
  skills: string[];
  tools_and_technologies: string[];
  projects: { name: string; description: string; technologies: string[] }[];
  responsibilities: string[];
  achievements: string[];
  education: { qualification: string; institution: string; year: string }[];
}

export interface JobData {
  job_title?: string | null;
  seniority: string;
  required_skills: string[];
  preferred_skills: string[];
  responsibilities: string[];
  required_experience?: string | null;
  competencies: string[];
  interview_topics: string[];
  role_suggestions: { title: string; confidence: number; reason: string }[];
}

export interface RoleDetection {
  roles: { title: string; confidence: number; reason: string }[];
  default_role: string | null;
  needs_user_choice: boolean;
}

export interface QuestionOut {
  id: string;
  sequence_number: number;
  question_text: string;
  competency: string;
  difficulty: number;
  question_type: string;
  priority: "core" | "optional";
  time_allocation_seconds: number;
  status: "pending" | "asked" | "answered" | "skipped" | "retaking";
}

export interface InterviewOut {
  id: string;
  job_role: string;
  duration_minutes: Duration;
  evaluation_rigor: Rigor;
  recording_mode: RecordingMode;
  status: InterviewStatus;
  failure_stage: string | null;
  failure_code: string | null;
  started_at: string | null;
  deadline_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface TranscriptLine {
  speaker: "interviewer" | "candidate";
  text: string;
  question_id?: string | null;
  at?: string;
}

export interface InterviewDetail extends InterviewOut {
  questions: QuestionOut[];
  objectives: string[];
  attempts: Record<
    string,
    {
      attempt_number: number;
      answer_source: string;
      transcript_text: string;
      selected_for_evaluation: boolean;
      is_skipped: boolean;
    }[]
  >;
  transcript: TranscriptLine[];
  server_time: string;
}

export interface InterviewSummary {
  id: string;
  job_role: string;
  duration_minutes: number;
  evaluation_rigor: Rigor;
  status: InterviewStatus;
  overall_score: number | null;
  report_status: "pending" | "completed" | "failed" | null;
  has_current_recording: boolean;
  created_at: string;
  completed_at: string | null;
}

export interface InterviewPage {
  items: InterviewSummary[];
  total: number;
  limit: number;
  offset: number;
  current_recording_interview_id: string | null;
}

export interface StatusOut {
  id: string;
  status: InterviewStatus;
  failure_stage: string | null;
  failure_code: string | null;
  report_status: "pending" | "completed" | "failed" | null;
  evaluation_attempts: number;
  started_at: string | null;
  deadline_at: string | null;
  server_time: string;
  remaining_seconds: number | null;
  progress: { total: number; core_total: number; answered: number; skipped: number; pending: number };
}

export interface LiveTokenOut {
  provider: string;
  token: string;
  model: string;
  api_version: string;
  expires_at: string;
  new_session_expires_at: string;
  connect_config: Record<string, unknown>;
  deadline_at: string | null;
  server_time: string;
}

export type EventType =
  | "session_started"
  | "question_asked"
  | "answer_submitted"
  | "question_skipped"
  | "answer_retake"
  | "transcript_segment"
  | "connection_lost"
  | "reconnected"
  | "paused"
  | "resumed"
  | "metric";

export interface InterviewEvent {
  client_event_id: string;
  event_type: EventType;
  question_id?: string;
  answer_source?: "voice" | "text";
  transcript_text?: string;
  exchange?: { speaker: "interviewer" | "candidate"; text: string }[];
  speaker?: "interviewer" | "candidate";
  text?: string;
  metric_name?:
    | "time_to_first_response_ms"
    | "transcription_delay_ms"
    | "ai_turn_duration_ms"
    | "live_connection_failed"
    | "recording_upload_failed";
  metric_value?: number;
  reason?: string;
}

export interface EventBatchOut {
  results: { client_event_id: string; sequence_number: number; duplicate: boolean }[];
  status: InterviewStatus;
  progress: StatusOut["progress"];
  remaining_seconds: number | null;
}

export interface Evidence {
  quote: string;
  supports: string;
  verified: boolean;
}

export interface QuestionEvaluation {
  question_id: string;
  sequence_number: number;
  question_text: string;
  competency: string;
  answer_source: string;
  answer_transcript: string;
  attempt_number: number;
  attempts_total: number;
  score: number;
  score_percent: number;
  rubric_label: string;
  rationale: string;
  evidence: Evidence[];
  gaps: string[];
  stronger_answer: string | null;
  confidence: "low" | "medium" | "high";
  has_unverified_evidence: boolean;
}

export interface CompetencyScore {
  competency: string;
  score: number | null;
  average_rubric: number | null;
  questions_evaluated: number;
  weight: number;
}

export interface ReportOut {
  interview_id: string;
  report_status: "pending" | "completed" | "failed";
  overall_score: number | null;
  evidence_sufficiency: "sufficient" | "limited" | "insufficient" | null;
  competency_scores: CompetencyScore[];
  question_evaluations: QuestionEvaluation[];
  strengths: string[];
  improvement_areas: string[];
  recommendations: string[];
  summary: string | null;
  unevaluated_questions: {
    question_id: string;
    sequence_number: number;
    question_text: string;
    competency: string;
    reason: string;
  }[];
  rubric: Record<string, string>;
  job_role: string;
  evaluation_rigor: Rigor;
  duration_minutes: number;
  created_at: string;
  feedback: { rating: number; comments: string | null } | null;
}

export interface UploadUrlOut {
  upload_id: string;
  bucket: string;
  path: string;
  token: string;
  signed_url: string;
  max_bytes: number;
}

export interface RecordingOut {
  interview_id: string;
  mime_type: string;
  file_size_bytes: number;
  duration_seconds: number | null;
  created_at: string;
}

export interface FeedbackItemOut {
  submitted_at: string;
  user_email: string | null;
  rating: number;
  comments: string | null;
  interview_id: string;
  job_role: string;
  duration_minutes: number;
  evaluation_rigor: string;
  overall_score: number | null;
}

export interface FeedbackListOut {
  items: FeedbackItemOut[];
  total: number;
}

export interface FeedbackSummaryOut {
  total_responses: number;
  average_rating: number;
  rating_counts: Record<number | string, number>;
  last_7_days: number;
  with_comments: number;
}

export interface AdminMeOut {
  admin: boolean;
}

export interface OverviewUsersOut {
  total: number;
  new_in_range: number;
  active_24h: number;
  active_7d: number;
  active_30d: number;
}

export interface OverviewInterviewsOut {
  created: number;
  started: number;
  completed: number;
  cancelled: number;
  failed: number;
  completion_rate: number;
}

export interface OverviewAveragesOut {
  overall_score: number;
  duration_minutes: number;
  questions_answered_per_completed: number;
}

export interface OverviewFeedbackOut {
  count: number;
  average_rating: number;
  rating_counts: Record<number | string, number>;
}

export interface RoleCount {
  role: string;
  count: number;
}

export interface OverviewBreakdownsOut {
  by_rigor: Record<string, number>;
  by_duration: Record<string, number>;
  top_roles: RoleCount[];
}

export interface DailySeriesPoint {
  date: string;
  new_users: number;
  interviews_started: number;
  interviews_completed: number;
  feedback_count: number;
}

export interface AIHealthRow {
  operation: string;
  model: string;
  calls: number;
  failures: number;
  avg_latency_ms: number;
}

export interface ErrorCodeRow {
  error_code: string;
  count: number;
}

export interface OverviewHealthOut {
  ai_usage: AIHealthRow[];
  top_error_codes: ErrorCodeRow[];
  connection_lost: number;
  live_connection_failed: number;
  recording_upload_failed: number;
  median_time_to_first_response_ms: number | null;
}

export interface OverviewLiveNowOut {
  count: number;
}

export interface AdminOverviewOut {
  users: OverviewUsersOut;
  interviews: OverviewInterviewsOut;
  averages: OverviewAveragesOut;
  feedback: OverviewFeedbackOut;
  breakdowns: OverviewBreakdownsOut;
  daily_series: DailySeriesPoint[];
  health: OverviewHealthOut;
  live_now: OverviewLiveNowOut;
}

export interface AdminUserSummary {
  user_id: string;
  email: string | null;
  display_name: string | null;
  signed_up_at: string | null;
  last_sign_in_at: string | null;
  interviews_total: number;
  interviews_completed: number;
  last_interview_at: string | null;
  average_score: number | null;
  feedback_count: number;
}

export interface AdminUserListOut {
  items: AdminUserSummary[];
  total: number;
}

export interface AdminUserInterviewItem {
  id: string;
  created_at: string;
  job_role: string;
  duration_minutes: number;
  evaluation_rigor: string;
  status: string;
  failure_stage: string | null;
  failure_code: string | null;
  overall_score: number | null;
  feedback_rating: number | null;
  feedback_comments: string | null;
}

export interface AdminUserDetailOut {
  user_id: string;
  email: string | null;
  display_name: string | null;
  signed_up_at: string | null;
  last_sign_in_at: string | null;
  interviews_total: number;
  interviews_completed: number;
  average_score: number | null;
  feedback_count: number;
  interviews: AdminUserInterviewItem[];
}

export interface AdminInterviewItem {
  id: string;
  created_at: string;
  user_id: string;
  user_email: string | null;
  job_role: string;
  duration_minutes: number;
  evaluation_rigor: string;
  recording_mode: string;
  status: string;
  failure_stage: string | null;
  failure_code: string | null;
  questions_total: number;
  questions_answered: number;
  questions_skipped: number;
  overall_score: number | null;
  feedback_rating: number | null;
}

export interface AdminInterviewListOut {
  items: AdminInterviewItem[];
  total: number;
}


