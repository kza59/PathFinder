#include "validate.h"

int parse_age(const char *text)
{
    int age = 0;
    for (const char *c = text; *c; c++)
        age = age * 10 + (*c - '0');
    return age;
}
