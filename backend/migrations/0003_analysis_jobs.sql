CREATE TABLE IF NOT EXISTS analysis_jobs (
    id UUID PRIMARY KEY,
    case_id UUID NOT NULL REFERENCES forensic_cases(id),
    evidence_id UUID NOT NULL REFERENCES evidences(id),
    perito_id UUID NOT NULL REFERENCES peritos(id),
    report_id UUID REFERENCES analysis_reports(id),
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    error_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- statement-break

CREATE INDEX IF NOT EXISTS ix_analysis_jobs_case_id ON analysis_jobs(case_id);

-- statement-break

CREATE INDEX IF NOT EXISTS ix_analysis_jobs_evidence_id ON analysis_jobs(evidence_id);

-- statement-break

CREATE INDEX IF NOT EXISTS ix_analysis_jobs_perito_id ON analysis_jobs(perito_id);

-- statement-break

CREATE INDEX IF NOT EXISTS ix_analysis_jobs_report_id ON analysis_jobs(report_id);
