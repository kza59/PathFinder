"""Top-level workflows share batch processing and reporting branches."""

from processing import buildReport, processBatch


def runWorkflow(values):
    batch = processBatch(values)
    report = buildReport(values)
    return batch + report


def runReports(values):
    report = buildReport(values)
    batch = processBatch([2, 4, 6])
    return report + batch
