#include "service.hpp"
#include "target.hpp"

Service::Service()
{
    value_ = target();
}

Service::~Service()
{
    target();
}

int Service::run() const
{
    return value_ + target();
}

int latest()
{
    return target();
}
