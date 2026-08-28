export type AssessmentStage = 'prepare' | 'collect' | 'review' | 'publish';
export type AssessmentStageState = 'complete' | 'current' | 'upcoming';

export const ASSESSMENT_STAGES: readonly {
  readonly id: AssessmentStage;
  readonly label: string;
  readonly hint: string;
}[] = [
  { id: 'prepare', label: 'Prepare', hint: 'Choose workspaces and pillars' },
  { id: 'collect', label: 'Collect', hint: 'Scan selected workspaces' },
  { id: 'review', label: 'Review', hint: 'Review selected pillars' },
  { id: 'publish', label: 'Publish', hint: 'Create the report' },
];

export function assessmentStageState(
  stage: AssessmentStage,
  current: AssessmentStage,
  published = false
): AssessmentStageState {
  if (published) return 'complete';
  const stageIndex = ASSESSMENT_STAGES.findIndex((one) => one.id === stage);
  const currentIndex = ASSESSMENT_STAGES.findIndex((one) => one.id === current);
  if (stageIndex < currentIndex) return 'complete';
  if (stageIndex === currentIndex) return 'current';
  return 'upcoming';
}
