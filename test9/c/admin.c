#include "admin.h"
#include "records.h"

struct record add_user(const char *name, const char *age_text)
{
    return load_record(name, age_text);
}
