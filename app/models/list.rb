class List < ActiveRecord::Base
  has_many :gifts
  
  def url
    "/#{id}"
  end
end