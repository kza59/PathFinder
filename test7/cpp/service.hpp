#pragma once

class Service {
public:
    Service();
    ~Service();
    int run() const;

private:
    int value_;
};

int latest();
