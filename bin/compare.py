#!/usr/bin/env python3

import json
import sys

def known_st(data):
  try:
    int(data.get('id', data['st']))
    return True
  except ValueError:
    return False

def exact_hits(data):
  alleles = data['alleles']
  return sum(known_st(h) for hits in alleles.values() for h in hits)

def inexact_hits(data):
  alleles = data['alleles']
  return sum(known_st(h) is False for hits in alleles.values() for h in hits)

def inexact_matching_bases(data):
  alleles = data['alleles']
  return sum(h['matchingBases'] for hits in alleles.values() for h in hits if not known_st(h))

def compare(before, after):
  if before['st'] == after['st']:
    print("inputs have same ST", file=sys.stdout)
    return 0
  
  if known_st(after) and not known_st(before):
    print("Is not a known ST", file=sys.stdout)
    return 1
  elif known_st(before) and not known_st(after):
    print(":(  Was a known ST", file=sys.stdout)
    return -1

  before_hits, after_hits = exact_hits(before), exact_hits(after)
  if before_hits < after_hits:
    print("Has more exact hits", file=sys.stdout)
    return 1
  elif before_hits > after_hits:
    print(":(  Has fewer exact hits", file=sys.stdout)
    return -1

  bases_before, bases_after = int(inexact_matching_bases(before) / inexact_hits(before)), int(inexact_matching_bases(after) / inexact_hits(after))
  if bases_before < bases_after:
    print("Inexact hits are longer", file=sys.stdout)
    return 1
  elif bases_before > bases_after:
    print(":(  Inexact hits are shorter", file=sys.stdout)
    return -1
  return 0

if __name__ == "__main__":
  import argparse

  parser = argparse.ArgumentParser(description="Check results have improved")
  parser.add_argument("before", help="Previous results")
  parser.add_argument("after", help="Updated results")
  args = parser.parse_args()
  with open(args.before, "r") as before_file, open(args.after, "r") as after_file:
    before = json.load(before_file)
    after = json.load(after_file)
  results = compare(before, after)
  if results < 0:
    sys.exit(1)
  # print(f"known_st={known_st(after)} exact_hits={exact_hits(after)} inexact_hits={inexact_hits(after)} inexact_matching_bases={inexact_matching_bases(after)}")
