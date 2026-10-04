from validate import parse_age


def load_record(row):
    name, age_text = row
    return {"name": name, "age": parse_age(age_text)}
