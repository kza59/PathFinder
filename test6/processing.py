"""Branches converge on shared record functions, with repeated call sites."""

from records import processRecord, summarizeRecords


def processBatch(values):
    primary = processRecord(values)
    secondary = processRecord([2, 4, 6])
    return primary + secondary


def buildReport(values):
    summary = summarizeRecords(values)
    detail = processRecord(values)
    return summary + detail
