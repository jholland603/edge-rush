/**
 * Draft War Room -- a self-contained fantasy draft-day board and pick
 * tracker. Unlike every other page on this site, this one has nothing to do
 * with the handicapping model: no D1/Worker calls, no games/teams/players
 * data. Everything lives in memory + localStorage, entirely client-side, so
 * it works offline at the kitchen table during an actual draft.
 *
 * State shape:
 *   settings: { teams, mySlot, scoring, draftType, roster: {QB,RB,WR,TE,FLEX,DST,K,BENCH}, auctionBudget }
 *   players:  [{ id, name, pos, posRank, team, bye, tier, rank, espnRank, valueSignal, flags: [] }]
 *             (rank/tier/posRank/bye come from blending FantasyPros' 2026 PPR
 *             consensus board with ESPN's own 2026 projected-points ranking --
 *             see the SEED_PLAYERS comment below for what each field means and
 *             where the value/trap flags come from)
 *   picks:    [{ overall, playerId, owner: 'me'|'other', paid?: number }], in the order they were made
 *   ui:       { posFilter, search, hideDrafted, activeTab }
 *
 * `picks` is append-only and IS the source of truth for "whose turn is it" --
 * the current overall pick number is always picks.length + 1. Nothing else
 * (my roster, the run tracker, the strategy nudges) is stored separately;
 * it's all derived fresh from players+picks+settings on every render. That
 * makes "Reset draft" and "Undo" trivial (just mutate `picks`) instead of
 * needing to keep three data structures in sync by hand.
 */
(function () {
  "use strict";

  const ROSTER_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "DST", "K", "BENCH"];
  const DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1, K: 1, BENCH: 6 };
  const POSES = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"];

  // Flag -> [badge class, label]. Badge colors reuse the site's existing
  // positive/negative/neutral/warn vocabulary rather than inventing new ones.
  const FLAG_META = {
    anchor: ["positive", "anchor"],
    value: ["positive", "value"],
    injury: ["warn", "injury risk"],
    trap: ["negative", "⚠ sexy pick"],
    rookie: ["neutral", "rookie"],
    handcuff: ["neutral", "handcuff"],
  };

  // Starter board: two independent 2026 rankings averaged together.
  //   1) FantasyPros' 2026 PPR Draft Rankings -- consensus of 129 experts,
  //      snapshotted Sep 8, 2026, right before Week 1 kickoff (full
  //      551-player/DST/K board this time -- no truncation).
  //   2) ESPN's 2026 Projected Stats rankings (season-long algorithmic FPTS
  //      projection, not a consensus/ADP board) from their default Pre-Draft
  //      Rankings, snapshotted Sep 8, 2026 -- covers their top 300 overall.
  //      (Both sources moved a bit from the Sep 1 snapshot now that real
  //      Week 1 stats exist -- e.g. ESPN's projection for Jahmyr Gibbs went
  //      365.0 -> 369.1 pts, and CeeDee Lamb passed De'Von Achane.)
  // overallRank/posRank below are the BLENDED order: each player's FantasyPros
  // rank and ESPN rank are averaged (players outside ESPN's top 300 just keep
  // their FantasyPros rank), then the whole board is re-sorted and re-numbered
  // from that average. Tier stays FantasyPros' own expert-assigned grouping
  // (a qualitative label, not recomputed from the blended number).
  // Each row is [overallRank, name, pos, posRank, team, bye, tier, valueSignal, espnRank]:
  //   bye                bye week, or null where FantasyPros shows none (free
  //                      agents with no current team).
  //   espnRank           this player's rank in ESPN's own top-300 board, or
  //                      null if they didn't rank him at all.
  //   valueSignal        blend of FantasyPros' own ECR-vs-ADP delta with the
  //                      FantasyPros-rank-minus-ESPN-rank gap (when ESPN has
  //                      him): positive = the field/ADP OR ESPN's own points
  //                      projection likes this player better than the other
  //                      signal does (a value/"falls to you" signal); negative
  //                      = the market is chasing name value ahead of where
  //                      either signal thinks he belongs (the "sexy pick"
  //                      signal). null means neither signal had enough to go
  //                      on.
  // This is a snapshot, not a live feed -- ADP drifts all preseason, so
  // re-import a fresh cheat-sheet CSV close to draft day (see the import note
  // above) if it's been more than a couple weeks since Sep 8, 2026.
  // prettier-ignore
  const SEED_PLAYERS = [
    [1,"Jahmyr Gibbs","RB",1,"DET",6,1,0,1],
    [2,"Ja'Marr Chase","WR",1,"CIN",6,1,0,3],
    [3,"Bijan Robinson","RB",2,"ATL",11,1,0,2],
    [4,"Puka Nacua","WR",2,"LAR",11,1,0,4],
    [5,"Jaxon Smith-Njigba","WR",3,"SEA",11,1,0.5,6],
    [6,"Amon-Ra St. Brown","WR",4,"DET",6,1,0,8],
    [7,"Christian McCaffrey","RB",3,"SF",8,2,-1,7],
    [8,"Jonathan Taylor","RB",4,"IND",13,2,0.5,5],
    [9,"Justin Jefferson","WR",5,"MIN",6,2,0.5,11],
    [10,"CeeDee Lamb","WR",6,"DAL",14,2,0,10],
    [11,"James Cook III","RB",5,"BUF",7,3,0,9],
    [12,"Drake London","WR",7,"ATL",11,2,1,18],
    [13,"Chase Brown","RB",6,"CIN",6,3,-0.5,14],
    [14,"A.J. Brown","WR",8,"NE",11,2,-1,20],
    [15,"De'Von Achane","RB",7,"MIA",6,3,-0.5,12],
    [16,"Nico Collins","WR",9,"HOU",8,3,0,23],
    [17,"Saquon Barkley","RB",8,"PHI",10,3,-0.5,15],
    [18,"Trey McBride","TE",1,"ARI",14,3,2,21],
    [19,"Omarion Hampton","RB",9,"LAC",7,4,1,13],
    [20,"Chris Olave","WR",10,"NO",8,3,1,24],
    [21,"Brock Bowers","TE",2,"LV",13,3,-0.5,22],
    [22,"Ashton Jeanty","RB",10,"LV",13,4,1,17],
    [23,"George Pickens","WR",11,"DAL",14,3,-1.5,27],
    [24,"Derrick Henry","RB",11,"BAL",13,4,0,16],
    [25,"Kenneth Walker III","RB",12,"KC",5,3,-5.5,28],
    [26,"Josh Allen","QB",1,"BUF",7,4,-2,26],
    [27,"Rashee Rice","WR",12,"KC",5,4,3,25],
    [28,"DeVonta Smith","WR",13,"PHI",10,3,-1,34],
    [29,"Malik Nabers","WR",14,"NYG",8,3,-2,33],
    [30,"Garrett Wilson","WR",15,"NYJ",13,4,5.5,29],
    [31,"Jeremiyah Love","RB",13,"ARI",14,5,5.5,19],
    [32,"Zay Flowers","WR",16,"BAL",13,4,-1,37],
    [33,"Breece Hall","RB",14,"NYJ",13,5,1.5,30],
    [34,"Ladd McConkey","WR",17,"LAC",7,4,1.5,40],
    [35,"Tetairoa McMillan","WR",18,"CAR",5,4,0.5,36],
    [36,"Lamar Jackson","QB",2,"BAL",13,4,-2.5,43],
    [37,"Kyren Williams","RB",15,"LAR",11,5,-2,32],
    [38,"Javonte Williams","RB",16,"DAL",14,5,-2,31],
    [39,"Colston Loveland","TE",3,"CHI",10,4,-1.5,42],
    [40,"Tee Higgins","WR",19,"CIN",6,4,0,41],
    [41,"Emeka Egbuka","WR",20,"TB",10,5,2,38],
    [42,"Jaylen Waddle","WR",21,"DEN",10,4,-1,48],
    [43,"Travis Etienne Jr.","RB",17,"NO",8,5,-0.5,35],
    [44,"Drake Maye","QB",3,"NE",11,4,-2,56],
    [45,"Davante Adams","WR",22,"LAR",11,5,3,44],
    [46,"D'Andre Swift","RB",18,"CHI",10,5,-1,46],
    [47,"Terry McLaurin","WR",23,"WAS",7,5,4,50],
    [48,"Quinshon Judkins","RB",19,"CLE",11,6,3,39],
    [49,"DJ Moore","WR",24,"BUF",7,5,-1.5,51],
    [50,"Bucky Irving","RB",20,"TB",10,5,-1,49],
    [51,"Cam Skattebo","RB",21,"NYG",8,5,-4.5,45],
    [52,"Tyler Warren","TE",4,"IND",13,5,-0.5,52],
    [53,"Luther Burden III","WR",25,"CHI",10,5,-3,59],
    [54,"Jameson Williams","WR",26,"DET",6,5,2,53],
    [55,"Joe Burrow","QB",4,"CIN",6,5,-5,64],
    [56,"Jayden Daniels","QB",5,"WAS",7,5,4,55],
    [57,"Bhayshul Tuten","RB",22,"JAC",7,6,4,47],
    [58,"Rome Odunze","WR",27,"CHI",10,6,2.5,54],
    [59,"David Montgomery","RB",23,"HOU",8,6,-4,57],
    [60,"Jalen Hurts","QB",6,"PHI",10,5,-3,66],
    [61,"Jadarian Price","RB",24,"SEA",11,6,-1,58],
    [62,"Mike Evans","WR",28,"SF",8,6,2.5,62],
    [63,"Carnell Tate","WR",29,"TEN",9,6,7.5,61],
    [64,"TreVeyon Henderson","RB",25,"NE",11,6,0.5,60],
    [65,"Marvin Harrison Jr.","WR",30,"ARI",14,6,3.5,63],
    [66,"Christian Watson","WR",31,"GB",11,5,-4.5,74],
    [67,"Parker Washington","WR",32,"JAC",7,5,-7,76],
    [68,"Rhamondre Stevenson","RB",26,"NE",11,6,-0.5,65],
    [69,"Harold Fannin Jr.","TE",5,"CLE",11,6,-1.5,69],
    [70,"Kyle Pitts Sr.","TE",6,"ATL",11,6,1,70],
    [71,"Michael Pittman Jr.","WR",33,"PIT",9,7,14.5,67],
    [72,"Jaylen Warren","RB",27,"PIT",9,6,-4.5,77],
    [73,"DK Metcalf","WR",34,"PIT",9,6,4,71],
    [74,"Tony Pollard","RB",28,"TEN",9,7,3,68],
    [75,"Caleb Williams","QB",7,"CHI",10,6,-6,87],
    [76,"Dak Prescott","QB",8,"DAL",14,6,-1,75],
    [77,"Justin Herbert","QB",9,"LAC",7,6,-0.5,84],
    [78,"Courtland Sutton","WR",35,"DEN",10,7,2,73],
    [79,"Sam LaPorta","TE",7,"DET",6,7,-3.5,78],
    [80,"George Kittle","TE",8,"SF",8,7,4,72],
    [81,"Wan'Dale Robinson","WR",36,"TEN",9,7,10.5,82],
    [82,"Trevor Lawrence","QB",10,"JAC",7,6,-3,95],
    [83,"Rico Dowdle","RB",29,"PIT",9,7,-5,88],
    [84,"Jonathon Brooks","RB",30,"CAR",5,7,-1,83],
    [85,"Tucker Kraft","TE",9,"GB",11,7,-11.5,92],
    [86,"Kenny Gainwell","RB",31,"TB",10,7,7,79],
    [87,"Michael Wilson","WR",37,"ARI",14,7,-0.5,85],
    [88,"Chris Godwin Jr.","WR",38,"TB",10,6,-7,104],
    [89,"Jaxson Dart","QB",11,"NYG",8,7,9.5,80],
    [90,"Brian Thomas Jr.","WR",39,"JAC",7,7,-6,97],
    [91,"Stefon Diggs","WR",40,"WAS",7,7,5.5,89],
    [92,"Alec Pierce","WR",41,"IND",13,7,1,90],
    [93,"Chuba Hubbard","RB",32,"CAR",5,7,-1,93],
    [94,"Josh Downs","WR",42,"IND",13,7,6,106],
    [95,"Brock Purdy","QB",12,"SF",8,7,8.5,98],
    [96,"MarShawn Lloyd","RB",33,"GB",11,8,0,86],
    [97,"RJ Harvey","RB",34,"DEN",10,7,-10.5,108],
    [98,"Travis Kelce","TE",10,"KC",5,7,-4,102],
    [99,"J.K. Dobbins","RB",35,"DEN",10,7,-6,100],
    [100,"Jakobi Meyers","WR",43,"JAC",7,8,14.5,94],
    [101,"Quentin Johnston","WR",44,"LAC",7,7,-6.5,117],
    [102,"Bo Nix","QB",13,"DEN",10,7,0.5,112],
    [103,"Rachaad White","RB",36,"WAS",7,8,9,99],
    [104,"Patrick Mahomes II","QB",14,"KC",5,7,0.5,109],
    [105,"Jordan Addison","WR",45,"MIN",6,8,1.5,105],
    [106,"Aaron Jones Sr.","RB",37,"MIN",6,8,11.5,96],
    [107,"Matthew Stafford","QB",15,"LAR",11,7,-7.5,113],
    [108,"Blake Corum","RB",38,"LAR",11,8,-7,111],
    [109,"Jayden Reed","WR",46,"GB",11,7,0.5,119],
    [110,"Kyle Monangai","RB",39,"CHI",10,8,3,101],
    [111,"Dallas Goedert","TE",11,"PHI",10,8,2,107],
    [112,"Makai Lemon","WR",47,"PHI",10,8,0.5,115],
    [113,"Matthew Golden","WR",48,"GB",11,8,12,103],
    [114,"Josh Jacobs","RB",40,"GB",11,9,0.5,81],
    [115,"Jacory Croskey-Merritt","RB",41,"WAS",7,8,-4.5,118],
    [116,"Jared Goff","QB",16,"DET",6,7,-2.5,131],
    [117,"Isaiah Likely","TE",12,"NYG",8,8,-5.5,116],
    [118,"Kyler Murray","QB",17,"MIN",6,8,8,122],
    [119,"Jake Ferguson","TE",13,"DAL",14,8,4,114],
    [120,"Dalton Kincaid","TE",14,"BUF",7,8,-2.5,126],
    [121,"KC Concepcion","WR",49,"CLE",11,8,-4,133],
    [122,"Khalil Shakir","WR",50,"BUF",7,8,17,110],
    [123,"Jordan Mason","RB",42,"MIN",6,8,-14,129],
    [124,"De'Zhaun Stribling","WR",51,"SF",8,8,-4.5,121],
    [125,"Jalen Coker","WR",52,"CAR",5,8,8.5,125],
    [126,"Romeo Doubs","WR",53,"NE",11,8,3,124],
    [127,"Tyler Shough","QB",18,"NO",8,8,13.5,128],
    [128,"Mark Andrews","TE",15,"BAL",13,8,4.5,120],
    [129,"Xavier Worthy","WR",54,"KC",5,8,4,123],
    [130,"Baker Mayfield","QB",19,"TB",10,8,0,140],
    [131,"Woody Marks","RB",43,"HOU",8,8,0.5,132],
    [132,"Tyjae Spears","RB",44,"TEN",9,9,8,127],
    [133,"Deebo Samuel Sr.","WR",55,"SF",8,9,2.5,130],
    [134,"Juwan Johnson","TE",16,"NO",8,8,2,144],
    [135,"Jordan Love","QB",20,"GB",11,8,-5.5,160],
    [136,"Chris Rodriguez Jr.","RB",45,"JAC",7,8,-2.5,142],
    [137,"Tyler Allgeier","RB",46,"ARI",14,8,-2.5,146],
    [138,"Jonah Coleman","RB",47,"DEN",10,9,6.5,139],
    [139,"Daniel Jones","QB",21,"IND",13,9,18,143],
    [140,"Zach Charbonnet","RB",48,"SEA",11,9,4,137],
    [141,"Houston Texans","DST",1,"HOU",8,9,-17,136],
    [142,"Dylan Sampson","RB",49,"CLE",11,9,13,148],
    [143,"Mike Washington Jr.","RB",50,"LV",13,9,-9.5,147],
    [144,"Travis Hunter","WR",56,"JAC",7,10,84,91],
    [145,"Keaton Mitchell","RB",51,"LAC",7,9,4.5,151],
    [146,"Jalen McMillan","WR",57,"TB",10,9,33,134],
    [147,"Malik Willis","QB",22,"MIA",6,8,-0.5,169],
    [148,"Alvin Kamara","RB",52,"NO",8,9,8,145],
    [149,"Denver Broncos","DST",2,"DEN",10,9,-12,138],
    [150,"Rashid Shaheed","WR",58,"SEA",11,9,-8,163],
    [151,"Hunter Henry","TE",17,"NE",11,9,3.5,149],
    [152,"Jordyn Tyson","WR",59,"NO",8,9,-12,170],
    [153,"Denzel Boston","WR",60,"CLE",11,9,0.5,164],
    [154,"Tre Tucker","WR",61,"LV",13,9,-0.5,171],
    [155,"T.J. Hockenson","TE",18,"MIN",6,10,9.5,150],
    [156,"Brian Robinson Jr.","RB",53,"ATL",11,9,1.5,161],
    [157,"Adonai Mitchell","WR",62,"NYJ",13,9,33,167],
    [158,"Jerry Jeudy","WR",63,"CLE",11,9,9.5,165],
    [159,"Keenan Allen","WR",64,"IND",13,10,13,152],
    [160,"Tank Bigsby","RB",54,"PHI",10,9,-4,174],
    [161,"Brandon Aubrey","K",1,"DAL",14,10,-29.5,154],
    [162,"Sam Darnold","QB",23,"SEA",11,8,-9,203],
    [163,"C.J. Stroud","QB",24,"HOU",8,9,-9.5,202],
    [164,"Isiah Pacheco","RB",55,"DET",6,10,18,141],
    [165,"Braelon Allen","RB",56,"NYJ",13,9,12,173],
    [166,"Cameron Dicker","K",2,"LAC",7,10,-10.5,155],
    [167,"Dontayvion Wicks","WR",65,"PHI",10,9,40.5,177],
    [168,"Ka'imi Fairbairn","K",3,"HOU",8,10,-12.5,157],
    [169,"Los Angeles Rams","DST",3,"LAR",11,9,-39,184],
    [170,"Brenton Strange","TE",19,"JAC",7,9,-20.5,198],
    [171,"Jalen Nailor","WR",66,"LV",13,10,14.5,172],
    [172,"Seattle Seahawks","DST",4,"SEA",11,9,-29.5,183],
    [173,"Jason Myers","K",4,"SEA",11,10,-10,156],
    [174,"Terrance Ferguson","TE",20,"LAR",11,10,7,162],
    [175,"Philadelphia Eagles","DST",5,"PHI",10,10,-23.5,186],
    [176,"Dalton Schultz","TE",21,"HOU",8,9,-19.5,210],
    [177,"Ray Davis","RB",57,"BUF",7,10,23.5,180],
    [178,"Eddy Pineiro","K",5,"SF",8,10,10.5,159],
    [179,"Calvin Ridley","WR",67,"TEN",9,10,27.5,166],
    [180,"Pittsburgh Steelers","DST",6,"PIT",9,10,-15.5,182],
    [181,"Cam Ward","QB",25,"TEN",9,9,-5,222],
    [182,"Chig Okonkwo","TE",22,"WAS",7,9,-10,219],
    [183,"Kayshon Boutte","WR",68,"HOU",8,9,-8.5,213],
    [184,"New England Patriots","DST",7,"NE",11,10,-17.5,188],
    [185,"Jauan Jennings","WR",69,"MIN",6,9,-0.5,204],
    [186,"Bryce Young","QB",26,"CAR",5,9,-5.5,221],
    [187,"Baltimore Ravens","DST",8,"BAL",13,10,-15.5,185],
    [188,"Jaylin Noel","WR",70,"HOU",8,10,50,179],
    [189,"Kenyon Sadiq","TE",23,"NYJ",13,10,-1,175],
    [190,"Tre' Harris","WR",71,"LAC",7,10,15.5,207],
    [191,"Tank Dell","WR",72,"HOU",8,11,45,135],
    [192,"Los Angeles Chargers","DST",9,"LAC",7,10,-12,191],
    [193,"Ryan Flournoy","WR",73,"DAL",14,10,13.5,208],
    [194,"Cam Little","K",6,"JAC",7,10,-21.5,193],
    [195,"Omar Cooper Jr.","WR",74,"NYJ",13,10,7,212],
    [196,"Harrison Mevis","K",7,"LAR",11,11,2,158],
    [197,"Caleb Douglas","WR",75,"MIA",6,11,20,168],
    [198,"Kansas City Chiefs","DST",10,"KC",5,10,1.5,190],
    [199,"Malik Washington","WR",76,"MIA",6,10,-4.5,214],
    [200,"Rashod Bateman","WR",77,"BAL",13,11,36.5,176],
    [201,"Ja'Kobi Lane","WR",78,"BAL",13,10,-14.5,201],
    [202,"Tyler Loop","K",8,"BAL",13,10,-7,195],
    [203,"Jacoby Brissett","QB",27,"ARI",14,10,-1.5,223],
    [204,"Samaje Perine","RB",58,"CIN",6,11,60.5,153],
    [205,"Jake Bates","K",9,"DET",6,11,-18,194],
    [206,"Emmett Johnson","RB",59,"KC",5,9,-27.5,241],
    [207,"Kimani Vidal","RB",60,"LAC",7,10,14,215],
    [208,"Kaelon Black","RB",61,"SF",8,10,-6.5,200],
    [209,"AJ Barner","TE",24,"SEA",11,10,-6.5,220],
    [210,"Najee Harris","RB",62,"NYG",8,11,25,181],
    [211,"Tyrone Tracy Jr.","RB",63,"NYG",8,9,-25.5,246],
    [212,"Detroit Lions","DST",11,"DET",6,11,-3.5,189],
    [213,"Malachi Fields","WR",79,"NYG",8,11,12.5,205],
    [214,"Cairo Santos","K",10,"CHI",10,11,-1,196],
    [215,"Devaughn Vele","WR",80,"NO",8,11,37.5,178],
    [216,"Pat Freiermuth","TE",25,"PIT",9,11,6.5,209],
    [217,"Cleveland Browns","DST",12,"CLE",11,11,5.5,187],
    [218,"Gunnar Helm","TE",26,"TEN",9,10,34,218],
    [219,"Zachariah Branch","WR",81,"ATL",11,11,15,211],
    [220,"Justice Hill","RB",64,"BAL",13,11,32,199],
    [221,"Pat Bryant","WR",82,"DEN",10,10,-9,263],
    [222,"Harrison Butker","K",11,"KC",5,11,-8.5,192],
    [223,"Jacksonville Jaguars","DST",13,"JAC",7,10,-46,255],
    [224,"Chris Bell","WR",83,"MIA",6,10,5.5,233],
    [225,"Germie Bernard","WR",84,"PIT",9,11,40.5,206],
    [226,"Malik Davis","RB",65,"DAL",14,11,19.5,228],
    [227,"Cooper Kupp","WR",85,"SEA",11,11,-8.5,226],
    [228,"Green Bay Packers","DST",14,"GB",11,11,-23.5,238],
    [229,"Sean Tucker","RB",66,"TB",10,10,0.5,247],
    [230,"Andy Borregales","K",12,"NE",11,11,-13,null],
    [231,"Jaylen Wright","RB",67,"MIA",6,11,19.5,216],
    [232,"Buffalo Bills","DST",15,"BUF",7,11,-40,null],
    [233,"Aaron Rodgers","QB",28,"PIT",9,10,-18,270],
    [234,"Chase McLaughlin","K",13,"TB",10,11,-11.5,240],
    [235,"Will Reichard","K",14,"MIN",6,12,-4.5,197],
    [236,"Geno Smith","QB",29,"NYJ",13,10,23,268],
    [237,"Chris Brooks","RB",68,"GB",11,11,28.5,225],
    [238,"Ollie Gordon II","RB",69,"MIA",6,11,107,217],
    [239,"Evan McPherson","K",15,"CIN",6,11,-34,257],
    [240,"Isaac TeSlaa","WR",86,"DET",6,11,-12.5,262],
    [241,"Antonio Williams","WR",87,"WAS",7,11,20.5,236],
    [242,"James Conner","RB",70,"ARI",14,11,35,null],
    [243,"Minnesota Vikings","DST",16,"MIN",6,10,-70,299],
    [244,"Troy Franklin","WR",88,"DEN",10,11,56,null],
    [245,"Nicholas Singleton","RB",71,"TEN",9,11,-12.5,267],
    [246,"George Holani","RB",72,"SEA",11,11,10,245],
    [247,"Chris Boswell","K",16,"PIT",9,11,-16.5,239],
    [248,"Ty Johnson","RB",73,"BUF",7,12,150,224],
    [249,"Cade Otton","TE",27,"TB",10,11,-21,261],
    [250,"Greg Dulcich","TE",28,"MIA",6,11,-22,259],
    [251,"Emanuel Wilson","RB",74,"SEA",11,11,34.5,251],
    [252,"Xavier Legette","WR",89,"CAR",5,12,118.5,229],
    [253,"Oronde Gadsden II","TE",29,"LAC",7,11,-33.5,291],
    [254,"Isaiah Davis","RB",75,"NYJ",13,11,216,242],
    [255,"Kaytron Allen","RB",76,"WAS",7,11,-16.5,280],
    [256,"Keon Coleman","WR",90,"BUF",7,11,23.5,254],
    [257,"Kaleb Johnson","RB",77,"GB",11,11,-17,266],
    [258,"Seth McGowan","RB",78,"IND",13,11,20.5,248],
    [259,"LeQuint Allen Jr.","RB",79,"JAC",7,12,102,244],
    [260,"Brashard Smith","RB",80,"KC",5,12,60,227],
    [261,"Jordan James","RB",81,"SF",8,12,11,249],
    [262,"Darius Slayton","WR",91,"FA",null,12,142.5,235],
    [263,"Cyrus Allen","WR",92,"KC",5,11,-58,null],
    [264,"Tyquan Thornton","WR",93,"KC",5,11,93,253],
    [265,"Fernando Mendoza","QB",30,"LV",13,11,-20,269],
    [266,"Colby Parkinson","TE",30,"LAR",11,11,56,null],
    [267,"Elic Ayomanor","WR",94,"TEN",9,11,60,null],
    [268,"Jack Bech","WR",95,"LV",13,11,14.5,274],
    [269,"Darnell Mooney","WR",96,"NYG",8,11,5.5,294],
    [270,"DeMario Douglas","WR",97,"NE",11,12,167.5,234],
    [271,"Ted Hurst III","WR",98,"TB",10,11,-17,284],
    [272,"Chimere Dike","WR",99,"TEN",9,11,-4,null],
    [273,"Demond Claiborne","RB",82,"MIN",6,11,-9,278],
    [274,"Evan Engram","TE",31,"DEN",10,11,39.5,289],
    [275,"New Orleans Saints","DST",17,"NO",8,12,-2,256],
    [276,"Jahan Dotson","WR",100,"ATL",11,12,138.5,230],
    [277,"Marvin Mims Jr.","WR",101,"DEN",10,12,16,264],
    [278,"David Njoku","TE",32,"LAC",7,11,-36,290],
    [279,"Tory Horton","WR",102,"SEA",11,12,12.5,275],
    [280,"Wil Lutz","K",17,"DEN",10,12,-71,null],
    [281,"Michael Penix Jr.","QB",31,"ATL",11,12,9,null],
    [282,"Deshaun Watson","QB",32,"CLE",11,12,69.5,271],
    [283,"Xavier Hutchinson","WR",103,"HOU",8,13,222.5,231],
    [284,"Kendre Miller","RB",83,"NO",8,12,25.5,276],
    [285,"Mason Taylor","TE",33,"NYJ",13,12,10,null],
    [286,"Kirk Cousins","QB",33,"LV",13,12,5,null],
    [287,"Emari Demercado","RB",84,"DAL",14,12,67.5,252],
    [288,"Will Shipley","RB",85,"PHI",10,12,174,250],
    [289,"Jalen Tolbert","WR",104,"MIA",6,13,194.5,232],
    [290,"Darren Waller","TE",34,"CAR",5,12,87,260],
    [291,"Elijah Sarratt","WR",105,"BAL",13,12,74,null],
    [292,"Tua Tagovailoa","QB",34,"ATL",11,12,-2,296],
    [293,"Andrei Iosivas","WR",106,"CIN",6,12,86,265],
    [294,"Theo Johnson","TE",35,"NYG",8,12,53,null],
    [295,"Christian Kirk","WR",107,"SF",8,12,-24,null],
    [296,"DJ Giddens","RB",86,"IND",13,12,89,281],
    [297,"San Francisco 49ers","DST",18,"SF",8,12,-36.5,286],
    [298,"Jacob Saylors","RB",87,"DET",6,13,23.5,243],
    [299,"Shedeur Sanders","QB",35,"CLE",11,12,-36,null],
    [300,"Kyle Williams","WR",108,"NE",11,12,-27,null],
    [301,"Devin Singletary","RB",88,"NYG",8,12,34,null],
    [302,"Eli Stowers","TE",36,"PHI",10,12,-24,null],
    [303,"Mike Gesicki","TE",37,"CIN",6,12,49,292],
    [304,"Atlanta Falcons","DST",19,"ATL",11,12,-59,null],
    [305,"Tahj Brooks","RB",89,"CIN",6,12,154,277],
    [306,"Mack Hollins","WR",109,"NE",11,12,203,295],
    [307,"Indianapolis Colts","DST",20,"IND",13,12,-10,298],
    [308,"Hollywood Brown","WR",110,"PHI",10,12,18,null],
    [309,"Skyler Bell","WR",111,"BUF",7,12,31,null],
    [310,"Tampa Bay Buccaneers","DST",21,"TB",10,13,27,237],
    [311,"Jaydon Blue","RB",90,"PHI",10,12,-30,null],
    [312,"Adam Randall","RB",91,"BAL",13,12,396,null],
    [313,"Michael Mayer","TE",38,"LV",13,12,87.5,293],
    [314,"Isaiah Bond","WR",112,"CLE",11,12,362,null],
    [315,"Jake Tonges","TE",39,"SF",8,12,2,null],
    [316,"Trevor Etienne","RB",92,"CAR",5,12,69,null],
    [317,"Devin Neal","RB",93,"FA",null,12,39,null],
    [318,"Charlie Kolar","TE",40,"LAC",7,12,275,null],
    [319,"Trey Benson","RB",94,"ARI",14,12,30,null],
    [320,"Brandon Aiyuk","WR",113,"SF",8,12,-42,null],
    [321,"Dallas Cowboys","DST",22,"DAL",14,13,-53.5,297],
    [322,"Chicago Bears","DST",23,"CHI",10,12,-101,null],
    [323,"Darnell Washington","TE",41,"PIT",9,12,-20,null],
    [324,"Isaac Guerendo","RB",95,"SF",8,12,306,null],
    [325,"Audric Estime","RB",96,"NO",8,13,39,null],
    [326,"Kevin Coleman Jr.","WR",114,"MIA",6,13,217.5,272],
    [327,"KaVontae Turpin","WR",115,"DAL",14,13,35,273],
    [328,"Jerome Ford","RB",97,"WAS",7,13,348,null],
    [329,"Jaleel McLaughlin","RB",98,"CLE",11,13,321,null],
    [330,"Charlie Smyth","K",18,"NO",8,13,-16,null],
    [331,"Bryce Lance","WR",116,"NO",8,13,198,null],
    [332,"Oscar Delp","TE",42,"NO",8,13,333,null],
    [333,"Trey Smack","K",19,"GB",11,13,-38,287],
    [334,"Elijah Arroyo","TE",43,"SEA",11,13,43,null],
    [335,"Sione Vaki","RB",99,"DET",6,13,92.5,282],
    [336,"Kareem Hunt","RB",100,"FA",null,13,59,null],
    [337,"Jarquez Hunter","RB",101,"FA",null,13,117,null],
    [338,"Nick Folk","K",20,"ATL",11,14,60,258],
    [339,"Tyreek Hill","WR",117,"FA",null,13,-85,null],
    [340,"Rasheen Ali","RB",102,"BAL",13,14,106,279],
    [341,"Cole Kmet","TE",44,"CHI",10,13,-38,null],
    [342,"Carson Beck","QB",36,"ARI",14,13,115,null],
    [343,"Kendrick Bourne","WR",118,"ARI",14,13,330,null],
    [344,"Dawson Knox","TE",45,"BUF",7,13,-24,null],
    [345,"Eli Raridon","TE",46,"NE",11,13,65,null],
    [346,"Spencer Shrader","K",21,"IND",13,14,-6.5,288],
    [347,"Joshua Palmer","WR",119,"BUF",7,13,14,null],
    [348,"Tez Johnson","WR",120,"TB",10,13,164,null],
    [349,"Olamide Zaccheaus","WR",121,"ATL",11,13,337,null],
    [350,"Jake Elliott","K",22,"PHI",10,13,-102,null],
    [351,"Tyler Higbee","TE",47,"LAR",11,13,17,null],
    [352,"Erick All Jr.","TE",48,"CIN",6,13,209,null],
    [353,"Bam Knight","RB",103,"ARI",14,13,100,null],
    [354,"Tyler Bass","K",23,"BUF",7,13,-118,null],
    [355,"Malik Benson","WR",122,"LV",13,13,262,null],
    [356,"Cincinnati Bengals","DST",24,"CIN",6,14,-21.5,300],
    [357,"J.J. McCarthy","QB",37,"MIN",6,13,-97,null],
    [358,"Noah Gray","TE",49,"KC",5,13,26,null],
    [359,"Roschon Johnson","RB",104,"CHI",10,13,-21,null],
    [360,"Jalen Royals","WR",123,"KC",5,13,167,null],
    [361,"Luke McCaffrey","WR",124,"WAS",7,13,-16,null],
    [362,"Konata Mumpfield","WR",125,"LAR",11,13,91,null],
    [363,"Cedric Tillman","WR",126,"NO",8,13,null,null],
    [364,"Brenen Thompson","WR",127,"LAC",7,13,316,null],
    [365,"Mac Jones","QB",38,"SF",8,13,38,null],
    [366,"Kalif Raymond","WR",128,"CHI",10,13,9,null],
    [367,"New York Giants","DST",25,"NYG",8,13,-135,null],
    [368,"Roman Wilson","WR",129,"PIT",9,13,96,null],
    [369,"Zavion Thomas","WR",130,"CHI",10,13,-67,null],
    [370,"Ja'Tavion Sanders","TE",50,"CAR",5,13,12,null],
    [371,"Treylon Burks","WR",131,"WAS",7,13,299,null],
    [372,"Max Klare","TE",51,"LAR",11,13,132,null],
    [373,"Justin Fields","QB",39,"KC",5,13,-1,null],
    [374,"Carolina Panthers","DST",26,"CAR",5,13,-110,null],
    [375,"New York Jets","DST",27,"NYJ",13,15,42,285],
    [376,"Eli Heidenreich","RB",105,"PIT",9,13,108,null],
    [377,"Raheim Sanders","RB",106,"CLE",11,13,180,null],
    [378,"Colbie Young","WR",132,"CIN",6,13,-23,null],
    [379,"Joe Mixon","RB",107,"FA",null,14,-104,null],
    [380,"Odell Beckham Jr.","WR",133,"NYG",8,14,-95,null],
    [381,"Anthony Richardson Sr.","QB",40,"IND",13,14,80,null],
    [382,"Noah Fant","TE",52,"NO",8,14,109,null],
    [383,"Tutu Atwell","WR",134,"LAR",11,14,7,null],
    [384,"Chris Brazzell II","WR",135,"CAR",5,14,332,null],
    [385,"Kene Nwangwu","RB",108,"NYJ",13,15,193,283],
    [386,"Daniel Carlson","K",24,"NO",8,14,90,null],
    [387,"Tennessee Titans","DST",28,"TEN",9,14,-142,null],
    [388,"Ty Simpson","QB",41,"LAR",11,14,-99,null],
    [389,"Dont'e Thornton Jr.","WR",136,"LV",13,14,269,null],
    [390,"Kyle Juszczyk","RB",109,"SF",8,14,35,null],
    [391,"Demarcus Robinson","WR",137,"SF",8,14,39,null],
    [392,"John Metchie III","WR",138,"CAR",5,14,305,null],
    [393,"Savion Williams","WR",139,"GB",11,14,299,null],
    [394,"Zane Gonzalez","K",25,"FA",null,14,145,null],
    [395,"Michael Carter","RB",110,"TEN",9,14,214,null],
    [396,"Jameis Winston","QB",42,"NYG",8,14,-80,null],
    [397,"Joe Flacco","QB",43,"CIN",6,14,-36,null],
    [398,"Jaylin Lane","WR",140,"WAS",7,14,270,null],
    [399,"Tommy Tremble","TE",53,"CAR",5,14,50,null],
    [400,"Jawhar Jordan","RB",111,"HOU",8,14,294,null],
    [401,"Jonnu Smith","TE",54,"GB",11,14,24,null],
    [402,"Barion Brown","WR",141,"NO",8,14,-41,null],
    [403,"Ben Sinnott","TE",55,"WAS",7,14,272,null],
    [404,"J'Mari Taylor","RB",112,"JAC",7,14,null,null],
    [405,"Marcus Mariota","QB",44,"WAS",7,14,213,null],
    [406,"Ashton Dulin","WR",142,"IND",13,14,-69,null],
    [407,"Cade Klubnik","QB",45,"NYJ",13,14,160,null],
    [408,"Justin Joly","TE",56,"MIA",6,14,161,null],
    [409,"Jordan Whittington","WR",143,"LAR",11,14,-5,null],
    [410,"CJ Daniels","WR",144,"LAR",11,14,-12,null],
    [411,"Chad Ryland","K",26,"ARI",14,14,-90,null],
    [412,"Blake Grupe","K",27,"NYJ",13,14,-144,null],
    [413,"Dylan Laube","RB",113,"LV",13,14,null,null],
    [414,"Ryan Fitzgerald","K",28,"CAR",5,14,-67,null],
    [415,"Daniel Bellinger","TE",57,"TEN",9,14,167,null],
    [416,"Isaiah Williams","WR",145,"NYJ",13,14,255,null],
    [417,"Mitchell Evans","TE",58,"CAR",5,14,104,null],
    [418,"Devontez Walker","WR",146,"BAL",13,14,-99,null],
    [419,"Joey Slye","K",29,"TEN",9,14,-93,null],
    [420,"Miami Dolphins","DST",29,"MIA",6,14,-111,null],
    [421,"Austin Hooper","TE",59,"ATL",11,14,103,null],
    [422,"Elijah Higgins","TE",60,"ARI",14,14,-16,null],
    [423,"Dameon Pierce","RB",114,"PHI",10,14,null,null],
    [424,"Nick Westbrook-Ikhine","WR",147,"IND",13,14,280,null],
    [425,"Washington Commanders","DST",30,"WAS",7,14,-142,null],
    [426,"Jeremy McNichols","RB",115,"WAS",7,14,null,null],
    [427,"Corey Kiner","RB",116,"NE",11,14,172,null],
    [428,"Hunter Luepke","RB",117,"DAL",14,14,-55,null],
    [429,"Austin Ekeler","RB",118,"FA",null,14,196,null],
    [430,"Luke Musgrave","TE",61,"GB",11,14,122,null],
    [431,"Dyami Brown","WR",148,"WAS",7,14,67,null],
    [432,"Phil Mafah","RB",119,"FA",null,14,79,null],
    [433,"Las Vegas Raiders","DST",31,"LV",13,14,-163,null],
    [434,"Tyler Goodson","RB",120,"ATL",11,14,null,null],
    [435,"Khalil Herbert","RB",121,"FA",null,14,null,null],
    [436,"Jam Miller","RB",122,"FA",null,14,193,null],
    [437,"Ameer Abdullah","RB",123,"JAC",7,14,96,null],
    [438,"AJ Dillon","RB",124,"CAR",5,14,-62,null],
    [439,"Jahdae Walker","WR",149,"CHI",10,14,-7,null],
    [440,"Deion Burks","WR",150,"IND",13,14,133,null],
    [441,"Brandon McManus","K",30,"FA",null,14,-28,null],
    [442,"Ben Sauls","K",31,"FA",null,14,-119,null],
    [443,"Dohnte Meyers","WR",151,"CIN",6,14,-95,null],
    [444,"Antonio Williams","RB",125,"FA",null,15,null,null],
    [445,"Drew Stevens","K",32,"WAS",7,15,-132,null],
    [446,"Ronnie Rivers","RB",126,"LAR",11,15,140,null],
    [447,"Max Bredeson","RB",127,"MIN",6,15,88,null],
    [448,"Tai Felton","WR",152,"MIN",6,15,242,null],
    [449,"Patrick Ricard","RB",128,"NYG",8,15,112,null],
    [450,"Zavier Scott","RB",129,"CHI",10,15,209,null],
    [451,"Alec Ingold","RB",130,"LAC",7,15,231,null],
    [452,"Miles Sanders","RB",131,"FA",null,15,null,null],
    [453,"Marlin Klein","TE",62,"HOU",8,15,-63,null],
    [454,"John Bates","TE",63,"WAS",7,15,215,null],
    [455,"Matt Hibner","TE",64,"BAL",13,15,null,null],
    [456,"Antonio Gibson","RB",132,"FA",null,15,174,null],
    [457,"Zach Ertz","TE",65,"FA",null,15,172,null],
    [458,"Reggie Gilliam","RB",133,"NE",11,15,102,null],
    [459,"Joe Milton III","QB",46,"DAL",14,15,193,null],
    [460,"Isaiah Williams","WR",153,"FA",null,15,null,null],
    [461,"Reggie Virgil","WR",154,"ARI",14,15,244,null],
    [462,"Elijah Moore","WR",155,"PHI",10,15,-28,null],
    [463,"Josh Oliver","TE",66,"MIN",6,15,-64,null],
    [464,"Raheem Mostert","RB",134,"LV",13,15,null,null],
    [465,"Marquez Valdes-Scantling","WR",156,"FA",null,15,null,null],
    [466,"Arizona Cardinals","DST",32,"ARI",14,15,-150,null],
    [467,"Josh Williams","RB",135,"TB",10,15,80,null],
    [468,"Jason Sanders","K",33,"NYJ",13,15,-145,null],
    [469,"Terrell Jennings","RB",136,"FA",null,15,94,null],
    [470,"Kalel Mullings","RB",137,"TEN",9,15,null,null],
    [471,"Tyler Badie","RB",138,"DEN",10,15,null,null],
    [472,"Nate Boerkircher","TE",67,"JAC",7,15,-10,null],
    [473,"Will Kacmarek","TE",68,"MIA",6,15,132,null],
    [474,"Tim Patrick","WR",157,"NYJ",13,15,null,null],
    [475,"Tyler Lockett","WR",158,"LV",13,15,null,null],
    [476,"Jimmy Horn Jr.","WR",159,"CAR",5,15,59,null],
    [477,"Carson Wentz","QB",47,"MIN",6,15,-15,null],
    [478,"Brandin Cooks","WR",160,"FA",null,15,null,null],
    [479,"DeAndre Hopkins","WR",161,"BAL",13,15,11,null],
    [480,"Tommy Myers","TE",69,"FA",null,15,null,null],
    [481,"Josh Cameron","WR",162,"JAC",7,15,-12,null],
    [482,"Greg Dortch","WR",163,"BUF",7,15,227,null],
    [483,"Adam Trautman","TE",70,"DEN",10,15,-30,null],
    [484,"Jalen Reagor","WR",164,"FA",null,15,null,null],
    [485,"Chris Blair","WR",165,"ATL",11,15,null,null],
    [486,"Jordan Watkins","WR",166,"SF",8,15,107,null],
    [487,"Tanner Koziol","TE",71,"JAC",7,15,107,null],
    [488,"Xavier Restrepo","WR",167,"TEN",9,15,null,null],
    [489,"Julius Chestnut","RB",139,"TEN",9,15,93,null],
    [490,"Alexander Mattison","RB",140,"FA",null,15,null,null],
    [491,"Zamir White","RB",141,"NO",8,15,144,null],
    [492,"Jaydn Ott","RB",142,"KC",5,15,null,null],
    [493,"Gardner Minshew II","QB",48,"ARI",14,15,-100,null],
    [494,"Drake Dabney","TE",72,"GB",11,15,-80,null],
    [495,"Damien Martinez","RB",143,"FA",null,15,null,null],
    [496,"Theo Wease Jr.","WR",168,"LAC",7,15,null,null],
    [497,"Jacob Cowing","WR",169,"SF",8,15,188,null],
    [498,"Noah Whittington","RB",144,"HOU",8,15,null,null],
    [499,"Brock Wright","TE",73,"DET",6,15,-120,null],
    [500,"Tyson Bagent","QB",49,"CHI",10,15,-149,null],
    [501,"KeAndre Lambert-Smith","WR",170,"LAC",7,15,-78,null],
    [502,"Darius Cooper","WR",171,"PHI",10,15,53,null],
    [503,"Jackson Hawes","TE",74,"BUF",7,15,-45,null],
    [504,"Scotty Miller","WR",172,"CHI",10,15,null,null],
    [505,"Diontae Johnson","WR",173,"FA",null,15,null,null],
    [506,"Xavier Smith","WR",174,"LAR",11,15,19,null],
    [507,"Drew Allar","QB",50,"PIT",9,15,-155,null],
    [508,"Cash Jones","RB",145,"ATL",11,15,null,null],
    [509,"Elijah Mitchell","RB",146,"FA",null,15,null,null],
    [510,"Pierre Strong Jr.","RB",147,"GB",11,15,null,null],
    [511,"Davis Mills","QB",51,"HOU",8,15,64,null],
    [512,"Tyrod Taylor","QB",52,"GB",11,15,-157,null],
    [513,"Foster Moreau","TE",75,"HOU",8,15,164,null],
    [514,"Luke Schoonmaker","TE",76,"DAL",14,15,-132,null],
    [515,"Lew Nichols III","RB",148,"PIT",9,15,null,null],
    [516,"Juice Wells Jr.","WR",175,"FA",null,15,null,null],
    [517,"Lan Larison","RB",149,"NE",11,15,null,null],
    [518,"Lil'Jordan Humphrey","WR",176,"DEN",10,15,-154,null],
    [519,"Sincere McCormick","RB",150,"SF",8,15,null,null],
    [520,"Drew Sample","TE",77,"CIN",6,15,-6,null],
    [521,"Michael Woods II","WR",177,"FA",null,15,null,null],
    [522,"Tyler Conklin","TE",78,"DET",6,15,21,null],
    [523,"Taylen Green","QB",53,"CLE",11,16,null,null],
    [524,"Roman Hemby","RB",151,"LV",13,16,null,null],
    [525,"Quinn Ewers","QB",54,"JAC",7,16,-99,null],
    [526,"Cade Stover","TE",79,"HOU",8,16,0,null],
    [527,"Gabe Davis","WR",178,"FA",null,16,null,null],
    [528,"British Brooks","RB",152,"HOU",8,16,42,null],
    [529,"Jermaine Burton","WR",179,"FA",null,16,null,null],
    [530,"Trey Lance","QB",55,"LAC",7,16,-146,null],
    [531,"Dean Connors","RB",153,"LAR",11,16,69,null],
    [532,"Jelani Woods","TE",80,"NYJ",13,16,-60,null],
    [533,"Kevin Austin Jr.","WR",180,"NO",8,16,null,null],
    [534,"Durham Smythe","TE",81,"BAL",13,16,-61,null],
    [535,"Taysom Hill","TE",82,"FA",null,16,79,null],
    [536,"Jack Strand","QB",56,"ATL",11,16,113,null],
    [537,"Dominic Zvada","K",34,"NYG",8,16,-243,null],
    [538,"Jalen Milroe","QB",57,"SEA",11,16,53,null],
    [539,"Riley Leonard","QB",58,"IND",13,16,101,null],
    [540,"Sam Roush","TE",83,"CHI",10,16,-145,null],
    [541,"Robert Henry Jr.","RB",154,"WAS",7,16,null,null],
    [542,"Mitch Tinsley","WR",181,"HOU",8,16,null,null],
    [543,"Tanner Hudson","TE",84,"CIN",6,16,null,null],
    [544,"Brittain Brown","RB",155,"CHI",10,16,null,null],
    [545,"Kendrick Law","WR",182,"DET",6,16,63,null],
    [546,"Mitchell Trubisky","QB",59,"TEN",9,16,-63,null],
    [547,"Jeremy Ruckert","TE",85,"NYJ",13,16,126,null],
    [548,"Tom Kennedy","WR",183,"DET",6,16,null,null],
    [549,"Tay Martin","WR",184,"DET",6,16,-173,null],
    [550,"Travis Homer","RB",156,"PIT",9,16,null,null],
    [551,"Hassan Haskins","RB",157,"NE",11,16,null,null],
  ];

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  // Turns each player's blended valueSignal into the board's "value"/"sexy
  // pick" flags -- this is the data-driven stand-in for what used to be my
  // own hand-typed guesses. Positive = FantasyPros' own ECR-vs-ADP delta
  // and/or ESPN's points projection rank him better than the field's ADP
  // does (he's likely to fall to you -- value); negative = the market is
  // drafting him ahead of what either signal thinks he's worth (name-value
  // outrunning the room -- the "sexy pick"/reach risk). The threshold
  // loosens with depth because a 6-spot swing at pick 8 is a real signal,
  // while the same swing at pick 400 is noise from a handful of samples --
  // past rank 200 the sample is too thin to trust either way, so no flag is
  // assigned.
  function deriveFlags(rank, valueSignal) {
    if (valueSignal === null || rank > 200) return [];
    const threshold = rank <= 50 ? 6 : rank <= 100 ? 10 : 15;
    if (valueSignal >= threshold) return ["value"];
    if (valueSignal <= -threshold) return ["trap"];
    return [];
  }

  function makeSeedPlayers() {
    return SEED_PLAYERS.map((r) => {
      const [rank, name, pos, posRank, team, bye, tier, valueSignal, espnRank] = r;
      return {
        id: slugify(name + "-" + team + "-" + pos),
        name,
        pos,
        posRank,
        team,
        bye,
        tier,
        rank,
        espnRank,
        valueSignal,
        flags: deriveFlags(rank, valueSignal),
      };
    });
  }

  // Bump this whenever SEED_PLAYERS is refreshed with a new rankings
  // snapshot. A returning visitor's board is saved in localStorage, so
  // without this, a code update alone would never reach anyone who already
  // has a saved draft -- they'd keep seeing whatever board existed the first
  // time they loaded the page, no matter how the seed data changes underneath
  // them. On load, a mismatched (or missing/pre-this-feature) version
  // refreshes just the player list -- settings and any picks already made
  // are left alone.
  const SEED_VERSION = "fantasypros-espn-blend-2026-09-08";

  function defaultState() {
    return {
      settings: { teams: 12, mySlot: 5, scoring: "PPR", draftType: "SNAKE", roster: Object.assign({}, DEFAULT_ROSTER), auctionBudget: 200 },
      players: makeSeedPlayers(),
      seedVersion: SEED_VERSION,
      picks: [],
      ui: { posFilter: "ALL", search: "", hideDrafted: true, activeTab: "board" },
    };
  }

  const STORE_KEY = "edgerush_draft_v1";
  let state;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state = raw ? JSON.parse(raw) : defaultState();
    if (!state || !state.settings || !state.players || !state.ui) state = defaultState();
    else if (state.seedVersion !== SEED_VERSION && state.seedVersion !== "custom") {
      // Built-in rankings changed since this board was last saved (or this
      // save predates the SEED_VERSION check entirely) -- refresh to the
      // current seed board, but keep settings/picks/ui as they were.
      state.players = makeSeedPlayers();
      state.seedVersion = SEED_VERSION;
    }
  } catch (e) {
    state = defaultState(); // storage unavailable (private mode, quota, etc.) -- run in-memory only
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore -- in-memory state still works for the rest of the session */
    }
  }

  /* ---------------- derived state ---------------- */

  function totalRounds() {
    return ROSTER_ORDER.reduce((sum, k) => sum + (state.settings.roster[k] || 0), 0);
  }

  // Standard snake order: odd rounds go slot 1->T, even rounds go T->1.
  function slotOnClock(overall, teams) {
    const round = Math.ceil(overall / teams);
    const posInRound = overall - (round - 1) * teams;
    return round % 2 === 1 ? posInRound : teams - posInRound + 1;
  }

  function currentOverall() {
    return state.picks.length + 1;
  }
  function currentRound(teams) {
    return Math.ceil(currentOverall() / teams);
  }

  function picksUntilMe() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    let overall = currentOverall();
    if (slotOnClock(overall, teams) === mine) return 0;
    for (let count = 0; count < teams * 2; count++) {
      if (slotOnClock(overall, teams) === mine) return count;
      overall++;
    }
    return null;
  }

  function myPickSequence() {
    const teams = state.settings.teams;
    const mine = state.settings.mySlot;
    const rounds = totalRounds();
    const out = [];
    for (let round = 1; round <= rounds; round++) {
      const overall = round % 2 === 1 ? (round - 1) * teams + mine : (round - 1) * teams + (teams - mine + 1);
      out.push({ round, overall });
    }
    return out;
  }

  function playerById(id) {
    return state.players.find((p) => p.id === id) || null;
  }
  function pickFor(id) {
    return state.picks.find((p) => p.playerId === id) || null;
  }
  function isDrafted(id) {
    return !!pickFor(id);
  }

  // Assigns my picks to roster slots in draft order: natural position slot
  // first, then FLEX (RB/WR/TE only), then bench, then an overflow bench
  // slot if every configured bench spot is already full. Recomputed fresh
  // every render rather than stored, so changing the roster template
  // mid-draft can't leave stale assignments behind.
  function computeMyRoster() {
    const slots = [];
    ROSTER_ORDER.forEach((type) => {
      const n = state.settings.roster[type] || 0;
      for (let i = 0; i < n; i++) slots.push({ type, playerId: null });
    });
    state.picks
      .filter((p) => p.owner === "me")
      .forEach((pk) => {
        const pl = playerById(pk.playerId);
        if (!pl) return;
        let idx = slots.findIndex((s) => s.type === pl.pos && s.playerId === null);
        if (idx === -1 && ["RB", "WR", "TE"].includes(pl.pos)) {
          idx = slots.findIndex((s) => s.type === "FLEX" && s.playerId === null);
        }
        if (idx === -1) idx = slots.findIndex((s) => s.type === "BENCH" && s.playerId === null);
        if (idx === -1) {
          slots.push({ type: "BENCH", playerId: null, overflow: true });
          idx = slots.length - 1;
        }
        slots[idx].playerId = pk.playerId;
      });
    return slots;
  }

  function positionRunLastN(n) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    state.picks.slice(-n).forEach((p) => {
      const pl = playerById(p.playerId);
      if (pl && counts.hasOwnProperty(pl.pos)) counts[pl.pos]++;
    });
    return counts;
  }

  function draftPhase(round, rounds) {
    if (round <= 3) return { label: "Foundation", text: "Best player available at RB/WR/TE. Resist the QB itch -- the position runs 15+ deep this year." };
    if (round <= 8) return { label: "Build", text: "Lock your starters. This is the window for a QB1 and your RB2/WR3 depth." };
    if (round <= Math.max(9, rounds - 4)) return { label: "Depth & bench", text: "Handcuffs with real standalone value, a TE2 if needed, high-upside bench flyers." };
    return { label: "Lottery tickets", text: "Rookie stashes, injury-comeback bets, and your DST/K -- last, always." };
  }

  // Bye-week stacking check, per position: QB/TE/DST/K only ever start ONE
  // player, so any two of them sharing a bye leaves that week uncovered --
  // the whole point of a backup at those spots is to NOT be dark the same
  // week as your starter. RB/WR start more than one, so the real mistake
  // there isn't any partial overlap (two of three WRs sharing a bye is
  // normal and usually fine) -- it's the WHOLE starting group going dark at
  // once. Both cases reduce to the same rule: flag a bye week once the
  // number of your rostered players at that position sharing it reaches
  // max(startersNeeded, 2). FLEX isn't modeled separately (it can be filled
  // by RB/WR/TE, so it doesn't have one fixed position to check against).
  function byeCollisionThreshold(pos) {
    return Math.max(state.settings.roster[pos] || 0, 2);
  }

  // { pos: { bye: count } } across everything currently on my roster.
  function myByeCounts() {
    const out = {};
    state.picks.filter((pk) => pk.owner === "me").forEach((pk) => {
      const pl = playerById(pk.playerId);
      if (!pl || !pl.bye) return;
      out[pl.pos] = out[pl.pos] || {};
      out[pl.pos][pl.bye] = (out[pl.pos][pl.bye] || 0) + 1;
    });
    return out;
  }

  // Plain-language summary of any bye-week collisions that already exist on
  // my roster (used in the nudges panel, after the picks are made).
  function byeCollisionSummary() {
    const myPlayers = state.picks.filter((pk) => pk.owner === "me").map((pk) => playerById(pk.playerId)).filter(Boolean);
    const out = [];
    ["QB", "RB", "WR", "TE", "DST", "K"].forEach((pos) => {
      const atPos = myPlayers.filter((pl) => pl.pos === pos && pl.bye);
      if (atPos.length < 2) return;
      const threshold = byeCollisionThreshold(pos);
      const byBye = {};
      atPos.forEach((pl) => { (byBye[pl.bye] = byBye[pl.bye] || []).push(pl); });
      Object.keys(byBye).forEach((bye) => {
        const group = byBye[bye];
        if (group.length >= threshold) {
          const names = group.map((pl) => pl.name).join(", ");
          out.push(`${group.length} of your ${pos}${group.length > 1 ? "s" : ""} share bye week ${bye} (${names}) -- make sure something else on your roster covers that week.`);
        }
      });
    });
    return out;
  }

  function generateNudges() {
    const out = [];
    const myPicks = state.picks.filter((p) => p.owner === "me");
    const myPlayers = myPicks.map((p) => playerById(p.playerId)).filter(Boolean);
    const posCount = { QB: 0, RB: 0, WR: 0, TE: 0 };
    myPlayers.forEach((pl) => { if (posCount.hasOwnProperty(pl.pos)) posCount[pl.pos]++; });
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();

    const last = myPlayers[myPlayers.length - 1];
    if (last && last.flags.includes("trap")) {
      out.push({ level: "danger", text: `"${last.name}" carries a boom/bust flag -- real name value, real bust risk. Watch early-season usage closely and don't be precious about benching or trading it.` });
    }
    if (posCount.QB === 0 && round <= 5) {
      out.push({ level: "good", text: "No QB yet -- that's fine. This position is 15+ deep; keep taking RB/WR value." });
    }
    if (posCount.QB === 0 && round >= 6 && round <= 10) {
      out.push({ level: "info", text: "Good window to grab your QB1 -- the Herbert/Lawrence/Goff/Purdy tier tends to fall right about here." });
    }
    if (posCount.QB >= 1) {
      const qbPick = myPicks.find((p) => { const pl = playerById(p.playerId); return pl && pl.pos === "QB"; });
      if (qbPick && Math.ceil(qbPick.overall / teams) <= 5) {
        out.push({ level: "warn", text: "You spent an early pick at QB -- make sure it's outproducing the RB/WR you passed on. Deep position this year, hold it to a high bar." });
      }
    }
    if (posCount.RB === 0 && round >= 4) {
      out.push({ level: "warn", text: "Zero RB territory now -- own it. Commit your next couple of picks to RB or the plan falls apart at the flex." });
    }
    const run = positionRunLastN(5);
    Object.keys(run).forEach((pos) => {
      if (run[pos] >= 3) out.push({ level: "danger", text: `${pos} run in progress -- ${run[pos]} of the last 5 picks. Decide now: get in on it or fade it and pivot.` });
    });
    if (round >= rounds - 2) {
      const openStarter = computeMyRoster().find((s) => s.playerId === null && s.type !== "BENCH");
      if (openStarter) out.push({ level: "danger", text: `Still an open starting ${openStarter.type} with the draft almost over -- don't punt it for a 4th bench flier.` });
    }
    byeCollisionSummary().forEach((msg) => out.push({ level: "warn", text: msg }));

    if (out.length === 0) out.push({ level: "info", text: "No alerts right now -- keep taking the best player on your board relative to tier, not name recognition." });
    return out.slice(0, 5);
  }

  /* ---------------- rendering ---------------- */

  function statCard(label, value, variant) {
    return `<div class="card stat-card${variant ? " " + variant : ""}"><div class="value mono">${value}</div><div class="label">${label}</div></div>`;
  }

  function renderScoreboard() {
    const teams = state.settings.teams;
    const overall = currentOverall();
    const round = currentRound(teams);
    const onClock = slotOnClock(overall, teams);
    const until = picksUntilMe();
    document.getElementById("scoreboard").innerHTML =
      statCard("Round", `${Math.min(round, totalRounds())} / ${totalRounds()}`) +
      statCard("Overall pick", overall) +
      statCard("On the clock", `Slot ${onClock}`, "warn") +
      statCard("Picks till you", until === 0 ? "YOU'RE UP" : until, until === 0 ? "danger" : "");
  }

  function renderSettingsForm() {
    document.getElementById("cfg-teams").value = state.settings.teams;
    document.getElementById("cfg-slot").value = state.settings.mySlot;
    document.getElementById("cfg-scoring").value = state.settings.scoring;
    document.getElementById("cfg-budget").value = state.settings.auctionBudget;
    document.getElementById("cfg-budget-control").style.display = state.settings.draftType === "AUCTION" ? "flex" : "none";
    document.querySelectorAll("#draft-type-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === state.settings.draftType);
    });
    document.getElementById("roster-inputs").innerHTML = ROSTER_ORDER.map(
      (k) => `<div class="rf"><label>${k}</label><input type="number" min="0" max="10" data-rk="${k}" value="${state.settings.roster[k]}"></div>`
    ).join("");
  }

  function renderRosterList() {
    const slots = computeMyRoster();
    const round = currentRound(state.settings.teams);
    const rounds = totalRounds();
    document.getElementById("roster-list").innerHTML = slots.map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const urgent = !pl && round >= rounds - 3;
      return `<li style="display:flex; justify-content:space-between; gap:var(--space-2); font-size:0.85rem; ${urgent ? "color:var(--color-danger);" : ""}">
        <span class="mono text-faint">${s.type}</span>
        <span style="flex:1; text-align:right;">${pl ? Util.escapeHtml(pl.name) : "open"}</span>
      </li>`;
    }).join("");
  }

  function renderRunTracker() {
    const run = positionRunLastN(8);
    document.getElementById("run-tracker").innerHTML = ["QB", "RB", "WR", "TE"].map((pos) => {
      const c = run[pos];
      const pct = Math.round((c / 8) * 100);
      return `<div class="run-row">
        <span class="run-row__pos">${pos}</span>
        <span class="run-row__track"><span class="run-row__fill${c >= 3 ? " alert" : ""}" style="width:${pct}%"></span></span>
        <span class="run-row__count">${c}</span>
      </div>`;
    }).join("");
    const alertPos = ["QB", "RB", "WR", "TE"].find((p) => run[p] >= 3);
    document.getElementById("run-alert").innerHTML = alertPos
      ? `<p class="text-danger" style="margin:var(--space-2) 0 0; font-size:0.82rem;">${alertPos} run -- ${run[alertPos]} of the last 8 picks</p>`
      : "";
  }

  function renderPosFilter() {
    document.getElementById("pos-filter").innerHTML = POSES.map(
      (p) => `<button type="button" data-pos="${p}" class="${state.ui.posFilter === p ? "active" : ""}">${p}</button>`
    ).join("");
  }

  function tierBadgeClass(t) {
    return t === 1 ? "tier1" : t === 2 ? "tier2" : "neutral";
  }

  function renderBoard() {
    const q = state.ui.search.trim().toLowerCase();
    const rows = state.players
      .filter((p) => {
        if (state.ui.posFilter !== "ALL" && p.pos !== state.ui.posFilter) return false;
        if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
        if (state.ui.hideDrafted && isDrafted(p.id)) return false;
        return true;
      })
      // Real consensus rank already reflects tier order -- sort on it
      // directly instead of tier+name so within-tier order matches the
      // actual board, falling back to name for any imported rows with no
      // rank (e.g. a hand-typed CSV).
      .sort((a, b) => (a.rank || 9999) - (b.rank || 9999) || a.name.localeCompare(b.name));

    const body = document.getElementById("board-body");
    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty-state">No players match -- clear filters or import a fresh board.</div></td></tr>`;
      return;
    }

    const byeCounts = myByeCounts();

    body.innerHTML = rows.map((p) => {
      const drafted = isDrafted(p.id);
      const pk = drafted ? pickFor(p.id) : null;
      const flagsHtml = p.flags.map((f) => {
        const meta = FLAG_META[f] || ["neutral", f];
        return `<span class="badge ${meta[0]}">${meta[1]}</span>`;
      }).join(" ");
      const posLabel = p.posRank ? `${p.pos}${p.posRank}` : p.pos;

      // Would drafting THIS player complete a bye-week collision with what
      // I already have at this position? (See byeCollisionThreshold.)
      let byeHtml = p.bye || "&ndash;";
      if (!drafted && p.bye) {
        const already = (byeCounts[p.pos] && byeCounts[p.pos][p.bye]) || 0;
        if (already >= byeCollisionThreshold(p.pos) - 1) {
          byeHtml = `${p.bye} <span class="badge warn" title="Would put ${already + 1} of your ${p.pos}s on bye week ${p.bye}">clash</span>`;
        }
      }

      let actionHtml;
      if (drafted) {
        actionHtml = `<span class="text-faint">${pk.owner === "me" ? "YOUR PICK" : "gone"}${pk.paid ? ` &middot; $${pk.paid}` : ""}</span>`;
      } else if (state.settings.draftType === "AUCTION") {
        actionHtml = `<span class="auction-bid">$<input type="number" min="1" max="${state.settings.auctionBudget}" value="1" data-bidfor="${p.id}">
          <button type="button" class="btn" data-act="mine-auction" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button></span>`;
      } else {
        actionHtml = `<button type="button" class="btn" data-act="mine" data-id="${p.id}">Mine</button>
          <button type="button" class="btn" data-act="gone" data-id="${p.id}">Gone</button>`;
      }

      return `<tr${drafted ? ' style="opacity:0.4;"' : ""}>
        <td><span class="badge ${tierBadgeClass(p.tier)}">T${p.tier}</span></td>
        <td>${drafted ? `<s>${Util.escapeHtml(p.name)}</s>` : Util.escapeHtml(p.name)} <span class="text-faint">${posLabel}</span></td>
        <td>${Util.escapeHtml(p.team)}</td>
        <td>${byeHtml}</td>
        <td>${flagsHtml}</td>
        <td style="text-align:right;">${actionHtml}</td>
      </tr>`;
    }).join("");
  }

  function findNextMine(seq, overall) {
    const next = seq.find((s) => s.overall >= overall);
    return next ? next.overall : null;
  }

  function renderMyDraft() {
    const teams = state.settings.teams;
    const round = currentRound(teams);
    const rounds = totalRounds();
    const phase = draftPhase(round, rounds);
    document.getElementById("phase-banner").innerHTML = `<strong>R${Math.min(round, rounds)} — ${phase.label}.</strong> ${phase.text}`;

    document.getElementById("nudges").innerHTML = generateNudges().map(
      (n) => `<div class="banner ${n.level} tight">${n.text}</div>`
    ).join("");

    const seq = myPickSequence();
    const overall = currentOverall();
    const nextMine = findNextMine(seq, overall);
    document.getElementById("pick-list").innerHTML = seq.map((s) => {
      const cls = s.overall < overall ? "done" : s.overall === nextMine ? "next" : "";
      return `<span class="chip ${cls}">R${s.round} &middot; #${s.overall}</span>`;
    }).join("");

    document.getElementById("roster-board").innerHTML = computeMyRoster().map((s) => {
      const pl = s.playerId ? playerById(s.playerId) : null;
      const cls = pl ? "filled" : round >= rounds - 3 ? "urgent" : "";
      return `<div class="roster-slot ${cls}"><div class="roster-slot__type">${s.type}</div><div class="roster-slot__name">${pl ? Util.escapeHtml(pl.name) : "Open"}</div></div>`;
    }).join("");
  }

  function renderAuctionTab() {
    const spent = state.picks.filter((p) => p.owner === "me" && p.paid).reduce((a, p) => a + p.paid, 0);
    const budget = state.settings.auctionBudget;
    const remaining = budget - spent;
    const mySlots = computeMyRoster();
    const filled = mySlots.filter((s) => s.playerId).length;
    const slotsLeft = Math.max(1, mySlots.length - filled);
    const maxBid = Math.max(1, remaining - (slotsLeft - 1));
    document.getElementById("auction-stats").innerHTML =
      statCard("Budget", "$" + budget) +
      statCard("Spent", "$" + spent) +
      statCard("Remaining", "$" + remaining, "warn") +
      statCard("Max sensible bid", "$" + maxBid);
  }

  const STRATEGY_HTML = `
    <article>
      <h2>Round by round</h2>
      <p>Think of a draft in four phases, not twelve or sixteen individual picks. <strong>Foundation (rounds 1&ndash;3):</strong>
        take the best RB/WR/TE on your board &mdash; pure talent and volume, no position requirement.
        <strong>Build (rounds 4&ndash;8):</strong> lock starters, including your QB1 if you waited.
        <strong>Depth &amp; bench (rounds 9 to about four-from-the-end):</strong> handcuffs with real standalone
        value, a TE2 if your TE1 is boom/bust, high-upside bench pieces. <strong>Lottery tickets (final rounds):</strong>
        rookie stashes, comeback bets, and only then your DST/K.</p>
      <div class="pullquote">The single biggest mistake in fantasy drafts isn't one bad pick &mdash; it's panicking
        into position runs that were never yours to chase.</div>

      <h2>Don't draft a QB in round 1 (or usually before round 6)</h2>
      <p>In a 1-QB league, the position is absurdly deep. A dozen-plus quarterbacks finish as viable weekly starters,
        and several of them (Goff, Purdy, Lawrence, Herbert-type profiles) are available five or six rounds after
        the "elite" tier goes off the board. Spending a top-24 pick on a QB means passing on a bell-cow RB or true
        WR1 for positional value you could have had at half the cost. The math only flips in
        <strong>superflex/2-QB</strong> leagues, where QBs become legitimately scarce and early investment is correct.</p>

      <h2>Hero RB, Zero RB, or balanced?</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Build</th><th>Idea</th><th>Best case</th><th>Worst case</th></tr></thead>
          <tbody>
            <tr><td>Hero RB</td><td>One elite bell-cow early, then pivot hard to WR/TE for several rounds</td>
              <td>True RB1 production without punting the receiver corps</td>
              <td>Your one RB gets hurt and you're replacing a foundation piece, not a luxury</td></tr>
            <tr><td>Zero RB</td><td>Ignore RB early, stack elite WRs, mine RB value from rounds 8&ndash;13</td>
              <td>WRs are more likely to hold their draft-day value than RBs &mdash; you bank stability</td>
              <td>If your late-round RB bets whiff, you're starting waiver-wire backs at your flex all year</td></tr>
            <tr><td>Balanced / BPA</td><td>Fill RB and WR need as value dictates, no fixed plan</td>
              <td>Simple, adapts to how the room actually drafts</td>
              <td>No plan means no edge &mdash; you can drift into thin at both spots</td></tr>
          </tbody>
        </table>
      </div>
      <p>None of these is "correct" in the abstract &mdash; they're responses to how RBs get hurt and lose touches
        more than WRs do. Pick a lane based on what falls to you in rounds 1&ndash;2, don't force it.</p>

      <h2>Avoiding the sexy pick</h2>
      <p>ADP is a popularity contest as much as a talent ranking. A player's draft position often reflects
        <em>last year's</em> highlight reel more than this year's actual opportunity &mdash; rookies with a hot
        preseason, a name you recognize from a big game, a "buy low" narrative that's really just hope. The fix
        isn't to avoid these players entirely; it's to price them at their tier, not their name.</p>
      <div class="card">
        <p style="margin:0;"><strong>Watch for the flag:</strong> players tagged <span class="badge negative">&#9888; sexy pick</span>
          on the board carry real name-value but a track record of hype outrunning production &mdash; boom/bust
          rookies off one big preseason, or aging stars whose role has quietly shrunk. Draft them where their tier
          says to, not where the buzz says to.</p>
      </div>

      <h2>Roster construction rules that hold up</h2>
      <p>Don't handcuff your own RB1 in the double-digit rounds &mdash; a backup with no standalone value is a
        wasted pick nine times out of ten; spend that pick on a player who helps you even if nothing changes
        upstairs. Reinforce WR depth all draft: when a starting WR gets hurt, the vacated targets usually scatter
        across two or three teammates rather than consolidating into one obvious must-add, so bench WR depth
        matters more than bench RB depth. And build a roster that survives losing your best player for a month,
        not a roster that only wins if everything breaks right.</p>

      <h2>In-draft discipline</h2>
      <p>Value relative to ADP beats need on paper &mdash; but need wins ties. If two players grade out equally on
        your board and one fills an empty starting spot, take that one. And when three of the same position leave
        the board in five picks, don't assume you have to follow: check whether the run is actually about to reach
        your tier, or whether it's early panic from teams two picks ahead of the value cliff.</p>
    </article>
    <aside class="card">
      <h3>Quick reference</h3>
      <ul>
        <li>QB before round 6 in 1-QB leagues: almost never worth it.</li>
        <li>One elite RB early beats zero elite RBs &mdash; but two isn't automatically better than one plus a stacked WR corps.</li>
        <li>Handcuffs: skip unless the backup has standalone value.</li>
        <li>DST/K: last two picks, always. Stream DST off matchups all season.</li>
        <li>A "sexy pick" flag means check the tier before you reach, not skip the player.</li>
      </ul>
    </aside>
  `;

  const AUCTION_ARTICLE_HTML = `
    <article style="max-width:66ch;">
      <h2>Auction strategy, short version</h2>
      <p><strong>Stars &amp; scrubs</strong> vs <strong>balanced</strong> is the real fork in the road.
        Stars-and-scrubs spends 60%+ of your budget on two or three elite players and fills the rest with $1
        flyers; balanced spreads $15&ndash;30 across six or seven solid starters. Balanced is more forgiving of one
        bad pick; stars-and-scrubs has a higher ceiling but one bust tanks your team.</p>
      <p><strong>Nominate players you don't want.</strong> Throwing out a name you have no interest in, early,
        drains other teams' budgets on someone who isn't going to help you. Save your actual targets for the
        middle third of the auction, once budgets are already dented.</p>
      <p><strong>Price enforcement.</strong> If a player is going for less than they're worth, bid it up even if
        you don't plan to buy &mdash; it forces the eventual buyer to spend more of their budget, which helps you
        later. Stop before the price you'd actually pay.</p>
      <p><strong>The $1 reserve rule.</strong> Never let your remaining budget dip below $1 per remaining roster
        slot. The Max sensible bid tile above already backs that reserve out for you.</p>
    </article>
  `;

  function render() {
    renderScoreboard();
    renderSettingsForm();
    renderRosterList();
    renderRunTracker();
    renderPosFilter();
    renderBoard();
    renderMyDraft();
    renderAuctionTab();
    document.getElementById("strategy-layout").innerHTML = STRATEGY_HTML;
    document.getElementById("auction-article").innerHTML = AUCTION_ARTICLE_HTML;
    save();
  }

  /* ---------------- actions ---------------- */

  function draftPlayer(id, owner, paid) {
    if (isDrafted(id)) return;
    state.picks.push({ overall: currentOverall(), playerId: id, owner, paid: paid || null });
    render();
  }

  function undoLast() {
    if (state.picks.length === 0) return;
    state.picks.pop();
    render();
  }

  document.getElementById("board-body").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === "mine") draftPlayer(id, "me");
    else if (act === "gone") draftPlayer(id, "other");
    else if (act === "mine-auction") {
      const input = document.querySelector(`input[data-bidfor="${id}"]`);
      const amt = Math.max(1, parseInt(input && input.value, 10) || 1);
      draftPlayer(id, "me", amt);
    }
  });

  document.getElementById("pos-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pos]");
    if (!b) return;
    state.ui.posFilter = b.dataset.pos;
    renderPosFilter();
    renderBoard();
    save();
  });

  document.getElementById("search-box").addEventListener("input", (e) => {
    state.ui.search = e.target.value;
    renderBoard();
    save();
  });

  document.getElementById("hide-drafted").addEventListener("change", (e) => {
    state.ui.hideDrafted = e.target.checked;
    renderBoard();
    save();
  });

  document.getElementById("draft-type-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    state.settings.draftType = b.dataset.type;
    renderSettingsForm();
    renderBoard();
    save();
  });

  document.getElementById("btn-apply").addEventListener("click", () => {
    const teams = parseInt(document.getElementById("cfg-teams").value, 10) || 12;
    let slot = parseInt(document.getElementById("cfg-slot").value, 10) || 1;
    if (slot > teams) slot = teams;
    state.settings.teams = teams;
    state.settings.mySlot = slot;
    state.settings.scoring = document.getElementById("cfg-scoring").value;
    state.settings.auctionBudget = parseInt(document.getElementById("cfg-budget").value, 10) || 200;
    document.querySelectorAll("#roster-inputs input").forEach((inp) => {
      state.settings.roster[inp.dataset.rk] = parseInt(inp.value, 10) || 0;
    });
    render();
  });

  document.getElementById("btn-reset-draft").addEventListener("click", () => {
    state.picks = [];
    render();
  });

  let fullResetArmed = false;
  const fullResetBtn = document.getElementById("btn-full-reset");
  fullResetBtn.addEventListener("click", () => {
    if (!fullResetArmed) {
      fullResetArmed = true;
      fullResetBtn.textContent = "Click again to confirm";
      setTimeout(() => { fullResetArmed = false; fullResetBtn.textContent = "Factory reset"; }, 4000);
      return;
    }
    state = defaultState();
    fullResetArmed = false;
    fullResetBtn.textContent = "Factory reset";
    render();
  });

  function parseCsv(text) {
    return text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(",").map((s) => s.trim()))
      .filter((parts) => parts.length >= 3 && parts[0] && parts[0].toLowerCase() !== "name")
      .map((parts) => ({
        id: slugify(parts[0] + "-" + (parts[2] || "") + "-" + (parts[1] || "")),
        name: parts[0],
        pos: (parts[1] || "").toUpperCase(),
        team: parts[2] || "",
        tier: parseInt(parts[3], 10) || 9,
        flags: parts[4] ? parts[4].split("|").map((s) => s.trim()).filter(Boolean) : [],
        bye: parts[5] ? parseInt(parts[5], 10) || null : null,
        rank: null,
        posRank: null,
        espnRank: null,
        valueSignal: null,
      }));
  }

  document.getElementById("btn-import").addEventListener("click", () => {
    const text = document.getElementById("import-box").value;
    const players = parseCsv(text);
    if (players.length === 0) return;
    state.players = players;
    // Mark this board as hand-imported so a future built-in SEED_VERSION
    // bump doesn't silently overwrite it -- see the seedVersion check above.
    state.seedVersion = "custom";
    render();
  });

  function currentBoardCsv() {
    const rows = ["name,pos,team,tier,flags,bye,status,owner,paid"];
    state.players.forEach((p) => {
      const pk = pickFor(p.id);
      rows.push([p.name, p.pos, p.team, p.tier, p.flags.join("|"), p.bye || "", pk ? "drafted" : "available", pk ? pk.owner : "", pk && pk.paid ? pk.paid : ""].join(","));
    });
    return rows.join("\n");
  }

  document.getElementById("btn-export-download").addEventListener("click", () => {
    const blob = new Blob([currentBoardCsv()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "draft-board.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btn-export-show").addEventListener("click", () => {
    const box = document.getElementById("import-box");
    box.value = currentBoardCsv();
    box.focus();
    box.select();
  });

  document.getElementById("tab-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tab-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    ["board", "mydraft", "strategy", "auction"].forEach((t) => {
      document.getElementById("tab-" + t).style.display = t === b.dataset.tab ? "" : "none";
    });
    state.ui.activeTab = b.dataset.tab;
    const p = new URLSearchParams(location.search);
    p.set("tab", b.dataset.tab);
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
    save();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      undoLast();
    }
  });

  /* ---------------- init ---------------- */
  const initialTab = new URLSearchParams(location.search).get("tab") || state.ui.activeTab || "board";
  const initialBtn = document.querySelector(`#tab-toggle button[data-tab="${initialTab}"]`);
  if (initialBtn) initialBtn.click();

  render();
})();
