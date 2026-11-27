/**
 * English translations — publish namespace
 *
 * This locale namespace carries the English strings for the
 * `/admin/publish` superadmin surface — the run trigger, the in-flight
 * progress panel, and the history table. The `counts` block is the
 * notice shown in the changelog's place while its counts load after the
 * page renders, and the retry notice when they fail.
 *
 * The `progress.stepLabels` block lets the progress
 * panel + history table render the per-fonds step IDs (`descriptions:`,
 * `children:`, `ead:`, `dc:`) with localised labels rather than
 * raw step prefixes. EN labels are presented for review alongside the
 * matching ES translations in the plan summary.
 *
 * The progress panel lists every step of the run, grouped by artefact:
 * `progress.state` names each step's state for screen readers,
 * `progress.groupCount` is a group's "3 of 10", and `progress.files_count`
 * what a children step wrote. The link files have their own `stepLabels`,
 * and `stepLabels.mets` names the METS steps of runs created when the
 * plan held them.
 *
 * The `changelog` labels and `detail.childrenFilesTotal` follow a
 * number, so they carry `_one` / `_other` forms.
 *
 * @version v0.9.0
 */
export default {
  title: "Publish",
  subtitle: "Export data to the public site",
  superadminRequired: "Only superadmins can access this page.",
  changelog: {
    title: "Changes since last export",
    descriptions: "Descriptions",
    repositories: "Repositories",
    entities: "Entities",
    places: "Places",
    added_one: "added",
    added_other: "added",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    added: "added",
    modified_one: "modified",
    modified_other: "modified",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    modified: "modified",
    unpublished_one: "unpublished",
    unpublished_other: "unpublished",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    unpublished: "unpublished",
    noChanges: "No changes",
    total: "total",
    fonds: "Fonds",
  },
  counts: {
    loadingTitle: "Counting what will be published…",
    loadingBody: "Fisqua is counting the descriptions, repositories, entities and places of every institution in the federation. This can take a few seconds.",
    failed: "The count could not be completed. You can still publish.",
    retry: "Retry",
  },
  controls: {
    title: "Export",
    selectFonds: "Select fonds",
    selectTypes: "Select data types",
    descriptions: "Descriptions",
    repositories: "Repositories",
    entities: "Entities",
    places: "Places",
    selectAll: "Select all",
    deselectAll: "Deselect all",
    triggerExport: "Start export",
    exporting: "Exporting…",
  },
  warning: {
    title: "Confirm publish run",
    body: "Publishing regenerates every export file for the selected fonds and data types. For large datasets this can take several minutes. The dashboard will show live progress — please leave it open until it finishes.",
    estimate: "Estimated time: about {{minutes}} min",
    confirm: "Yes, start publishing",
    cancel: "Cancel",
  },
  progress: {
    title: "Export progress",
    step: "Step",
    of: "of",
    starting: "Starting…",
    processing: "Processing",
    complete: "Export complete",
    error: "Export error",
    records: "records",
    records_count_one: "{{formattedCount}} record",
    records_count_other: "{{formattedCount}} records",
    stepElapsed: "Step time: {{minutes}}m {{seconds}}s",
    totalElapsed: "Total time: {{minutes}}m {{seconds}}s",
    lastUpdate: "Last update: {{timestamp}}",
    files_count_one: "{{formattedCount}} file",
    files_count_other: "{{formattedCount}} files",
    stepsTitle: "Steps",
    groupCount: "{{done}} of {{total}}",
    duration: "{{minutes}}m {{seconds}}s",
    state: {
      completed: "Completed",
      running: "In progress",
      pending: "Pending",
      failed: "Failed",
      partial: "Partly completed",
    },
    reassurance: {
      children: "Writing per-parent children files — this is the longest step for large fonds. It is safe to leave the page open.",
      index: "Writing the descriptions index — almost done.",
    },
    stepLabels: {
      descriptions: "Descriptions",
      children: "Children files",
      mets: "METS XML",
      ead: "EAD3 finding aid",
      dc: "Dublin Core records",
      repositories: "Repositories",
      entities: "Entities",
      places: "Places",
      index: "Descriptions index",
      entity_links: "Entity links file",
      place_links: "Place links file",
    },
  },
  history: {
    title: "Export history",
    date: "Date",
    status: "Status",
    triggeredBy: "Triggered by",
    duration: "Duration",
    records: "Records",
    recordsDescriptions: "desc",
    recordsDescriptions_count_one: "{{formattedCount}} desc",
    recordsDescriptions_count_other: "{{formattedCount}} desc",
    recordsEntities: "ent",
    recordsEntities_count_one: "{{formattedCount}} ent",
    recordsEntities_count_other: "{{formattedCount}} ent",
    recordsPlaces: "pl",
    recordsPlaces_count_one: "{{formattedCount}} pl",
    recordsPlaces_count_other: "{{formattedCount}} pl",
    recordsRepositories: "repo",
    recordsRepositories_count_one: "{{formattedCount}} repo",
    recordsRepositories_count_other: "{{formattedCount}} repo",
    noHistory: "No previous exports",
    complete: "Complete",
    error: "Error",
    running: "Running",
    pending: "Pending",
  },
  detail: {
    title: "Publish run",
    backToPublish: "Back to the publish page",
    overview: "Overview",
    runId: "Run ID",
    workflowInstanceId: "Workflow instance ID",
    status: "Status",
    triggeredBy: "Triggered by",
    selectedFonds: "Selected fonds",
    selectedTypes: "Selected data types",
    timings: "Timings",
    createdAt: "Created",
    startedAt: "Started",
    completedAt: "Completed",
    duration: "Duration",
    currentStep: "Current step",
    stepStartedAt: "Step started",
    stepCompletedAt: "Step completed",
    lastHeartbeatAt: "Last heartbeat",
    stepsCompleted: "Steps completed",
    recordCounts: "Per-step record counts",
    noRecordCounts: "No record counts recorded",
    childrenFiles: "Children files",
    childrenFilesTotal_one: "{{count}} children/{refCode}.json file written across all fonds",
    childrenFilesTotal_other: "{{count}} children/{refCode}.json files written across all fonds",
    // Base form: i18next falls back to it when Spanish selects the "many" category.
    childrenFilesTotal: "{{count}} children/{refCode}.json files written across all fonds",
    childrenFilesFonds: "Fonds",
    childrenFilesCount: "Files written",
    errorTitle: "Error",
    rawJson: "Raw data",
    notFound: "Export run not found",
  },
  rebuild: {
    title: "Next step: rebuild the site",
    message: "Export complete. To publish changes, trigger the site rebuild in GitHub Actions.",
    link: "Go to GitHub Actions",
  },
  publish_in_progress: "Another publish is still running. Wait for it to finish before starting a new one.",
  publish_start_failed: "The publish could not be started. Try again.",
} as const;
