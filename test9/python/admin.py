from records import load_record


def add_user(name, age_text):
    return load_record([name, age_text])
