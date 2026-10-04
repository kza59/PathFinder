#include "admin.hpp"
#include "records.hpp"

Record add_user(const std::string &name, const std::string &age_text)
{
    return load_record(name, age_text);
}
