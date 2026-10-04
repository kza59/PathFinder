#pragma once

#include <string>

struct Record {
    std::string name;
    int age;
};

Record load_record(const std::string &name, const std::string &age_text);
