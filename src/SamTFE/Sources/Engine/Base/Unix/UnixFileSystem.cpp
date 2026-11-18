/* Copyright (c) 2002-2012 Croteam Ltd. All rights reserved. */

/* rcg10142001 Implemented. */


// !!! FIXME: rcg10142001 This should really be using CTStrings...


#include <algorithm>
#include <string>
#include <vector>
#include <strings.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pwd.h>
#include <sys/types.h>
#include <dirent.h>
#include <sys/param.h>
#include <unistd.h>

#include <Engine/Engine.h>
#include <Engine/Base/FileSystem.h>

#include "SDL.h"

ENGINE_API CFileSystem *_pFileSystem = NULL;


class CUnixFileSystem : public CFileSystem
{
public:
    CUnixFileSystem(const char *argv0, const char *gamename);
    virtual ~CUnixFileSystem(void);
    virtual void GetExecutablePath(char *buf, ULONG bufSize);
    virtual void GetUserDirectory(char *buf, ULONG bufSize);
    virtual CDynamicArray<CTString> *FindFiles(const char *dir,
                                               const char *wildcard);
protected:
    char *exePath;
    char *userDir;
};

CFileSystem *CFileSystem::GetInstance(const char *argv0, const char *gamename)
{
    return(new CUnixFileSystem(argv0, gamename));
}


const char *CFileSystem::GetDirSeparator(void)
{
    return("/");
}


BOOL CFileSystem::IsDummyFile(const char *fname)
{
    return( (strcmp(fname, ".") == 0) || (strcmp(fname, "..") == 0) );
}


BOOL CFileSystem::Exists(const char *fname)
{
    struct stat s;
    if (stat(fname, &s) == -1)
        return(FALSE);

    return(TRUE);
}


BOOL CFileSystem::IsDirectory(const char *fname)
{
    struct stat s;
    if (stat(fname, &s) == -1){
        #ifdef NDEBUG
        //CPrintF(TRANSV("Debug: CFileSystem::IsDirectory error'%s' : \n"), (const char *)fname);
        #endif //_DEBUG
        return(FALSE);
    }
    #ifdef NDEBUG
	/*CPrintF(TRANSV("Debug: '%s' : "), (const char *)fname);
    switch (s.st_mode & S_IFMT) {
     case S_IFBLK:  CPrintF(TRANSV("block device\n"));            break;
     case S_IFCHR:  CPrintF(TRANSV("character device\n"));        break;
     case S_IFDIR:  CPrintF(TRANSV("directory\n"));               break;
     case S_IFIFO:  CPrintF(TRANSV("FIFO/pipe\n"));               break;
     case S_IFLNK:  CPrintF(TRANSV("symlink\n"));                 break;
     case S_IFREG:  CPrintF(TRANSV("regular file\n"));            break;
     case S_IFSOCK: CPrintF(TRANSV("socket\n"));                  break;
    default:        CPrintF(TRANSV("unknown?\n"));                break;
    }*/
    #endif //_DEBUG

    return(S_ISDIR(s.st_mode) ? TRUE : FALSE);
}


CUnixFileSystem::CUnixFileSystem(const char *argv0, const char *gamename)
{
    exePath = SDL_GetBasePath();
    userDir = SDL_GetPrefPath("Serious-Engine", gamename);
}


CUnixFileSystem::~CUnixFileSystem(void)
{
    SDL_free(userDir);
    SDL_free(exePath);
}


void CUnixFileSystem::GetExecutablePath(char *buf, ULONG bufSize)
{
    SDL_snprintf(buf, bufSize, "%s", exePath);
}


void CUnixFileSystem::GetUserDirectory(char *buf, ULONG bufSize)
{
    SDL_snprintf(buf, bufSize, "%s", userDir);
}


CDynamicArray<CTString> *CUnixFileSystem::FindFiles(const char *dir,
                                                   const char *wildcard)
{
    CDynamicArray<CTString> *retval = new CDynamicArray<CTString>;
    DIR *d = opendir(dir);

    if (d != NULL)
    {
        // web port: return entries in case-insensitive name order, as Windows does. readdir()
        // order depends on the filesystem (MEMFS, WASMFS, ext4...), and load order matters.
        std::vector<std::string> names;
        struct dirent *dent;
        while ((dent = readdir(d)) != NULL)
        {
            CTString str(dent->d_name);
            if (str.Matches(wildcard))
                names.push_back(dent->d_name);
        }
        closedir(d);
        std::sort(names.begin(), names.end(), [](const std::string &a, const std::string &b) {
            return strcasecmp(a.c_str(), b.c_str()) < 0; });
        for (size_t i = 0; i < names.size(); i++)
            *retval->New() = CTString(names[i].c_str());
    }

    return(retval);
}

// end of UnixFileSystem.cpp ...


