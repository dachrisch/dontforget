export interface CandidateEvent {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
  status: 'candidate' | 'approved';
}

export interface CreateQueryResponse {
  queryId: string;
  candidates: CandidateEvent[];
}

export interface ApproveResponse {
  icsUrl: string;
  rssUrl: string;
}