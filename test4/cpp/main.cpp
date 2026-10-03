#include "animals.hpp"

void dog_owner()
{
    Dog().speak();
}

void cat_owner()
{
    Cat().speak();
}

int main()
{
    dog_owner();
    cat_owner();
    return 0;
}
