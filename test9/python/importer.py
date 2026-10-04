from records import load_record


def import_all(rows):
    records = []
    for row in rows:
        records.append(load_record(row))
    return records
