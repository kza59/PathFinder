#include "records.hpp"
#include "validate.hpp"

Record load_record(const std::string &name, const std::string &age_text)
{
    return Record{ name, parse_age(age_text) };
}
