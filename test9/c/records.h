#ifndef RECORDS_H
#define RECORDS_H

struct record {
    const char *name;
    int age;
};

struct record load_record(const char *name, const char *age_text);

#endif
