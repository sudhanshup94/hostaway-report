#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:?Usage: deploy.sh PROJECT_ID REGION}"
REGION="${2:?Usage: deploy.sh PROJECT_ID REGION}"
REPOSITORY="hireavilla-reporting"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/hostaway-report:$(git rev-parse --short HEAD)"
RUNTIME_SA="hireavilla-report-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="hireavilla-report-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPOSITORY" --repository-format=docker --location="$REGION"
gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create hireavilla-report-runtime --display-name='Hireavilla report runtime'
gcloud iam service-accounts describe "$SCHEDULER_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create hireavilla-report-scheduler --display-name='Hireavilla report scheduler'

gcloud builds submit --tag "$IMAGE"

SECRETS="HOSTAWAY_ACCOUNT_ID=hostaway-account-id:latest,HOSTAWAY_API_KEY=hostaway-api-key:latest,SMTP_HOST=smtp-host:latest,SMTP_PORT=smtp-port:latest,SMTP_SECURE=smtp-secure:latest,SMTP_USER=smtp-user:latest,SMTP_PASS=smtp-pass:latest,EMAIL_FROM=email-from:latest,EMAIL_TO=email-to:latest"
for SECRET in hostaway-account-id hostaway-api-key smtp-host smtp-port smtp-secure smtp-user smtp-pass email-from email-to; do
  gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:${RUNTIME_SA}" --role='roles/secretmanager.secretAccessor' >/dev/null
done

deploy_job() {
  local job="$1" mode="$2"
  gcloud run jobs deploy "$job" --image="$IMAGE" --region="$REGION" --service-account="$RUNTIME_SA" \
    --set-secrets="$SECRETS" --set-env-vars="REPORT_MODE=${mode}" --task-timeout=15m --max-retries=0 --tasks=1 --parallelism=1
  gcloud run jobs add-iam-policy-binding "$job" --region="$REGION" --member="serviceAccount:${SCHEDULER_SA}" --role='roles/run.invoker' >/dev/null
}

deploy_job hireavilla-daily-operations operations
deploy_job hireavilla-sales-portfolio portfolio

create_schedule() {
  local scheduler_job="$1" cron="$2" target_job="$3"
  gcloud scheduler jobs delete "$scheduler_job" --location="$REGION" --quiet >/dev/null 2>&1 || true
  gcloud scheduler jobs create http "$scheduler_job" \
    --location="$REGION" --schedule="$cron" --time-zone='Asia/Kolkata' --http-method=POST \
    --uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${target_job}:run" \
    --oauth-service-account-email="$SCHEDULER_SA" --oauth-token-scope='https://www.googleapis.com/auth/cloud-platform' \
    --attempt-deadline=60s --max-retry-attempts=0 --paused
}

create_schedule hireavilla-daily-operations-schedule '0 18 * * *' hireavilla-daily-operations
create_schedule hireavilla-sales-portfolio-schedule '15 18 * * *' hireavilla-sales-portfolio

echo 'Cloud Run jobs deployed. Schedules are paused until shadow validation is complete.'
