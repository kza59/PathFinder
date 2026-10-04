#include "records.h"
#include "validate.h"

struct record load_record(const char *name, const char *age_text)
{
    struct record r = { name, parse_age(age_text) };
    return r;
}
