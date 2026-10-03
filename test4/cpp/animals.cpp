#include "animals.hpp"

#include <cstdio>

void make_sound(const char *sound)
{
    std::puts(sound);
}

void Dog::speak() const
{
    make_sound("woof");
}

void Cat::speak() const
{
    make_sound("meow");
}
